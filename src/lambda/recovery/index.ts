import type { EventBridgeEvent, Context } from "aws-lambda";
import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from "@aws-sdk/client-ssm";
import type { SpotInterruptionDetail } from "../../config/types.js";

type SpotInterruptionEvent = EventBridgeEvent<
  "EC2 Spot Instance Interruption Warning",
  SpotInterruptionDetail
>;

interface EnvConfig {
  parameterStorePrefix: string;
  subnetId: string;
  launchTemplateId: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

// Initialize AWS clients at module level (reuse across invocations)
const ec2Client = new EC2Client({});
const ssmClient = new SSMClient({});

// Load configuration from environment variables
function loadConfig(): EnvConfig {
  const parameterStorePrefix = process.env.PARAMETER_STORE_PREFIX;
  const subnetId = process.env.SUBNET_ID;
  const launchTemplateId = process.env.LAUNCH_TEMPLATE_ID;
  const validLogLevels: EnvConfig["logLevel"][] = [
    "debug",
    "info",
    "warn",
    "error",
  ];
  const rawLogLevel = process.env.LOG_LEVEL ?? "info";
  const logLevel = validLogLevels.includes(rawLogLevel as EnvConfig["logLevel"])
    ? (rawLogLevel as EnvConfig["logLevel"])
    : "info";

  const missing = [
    ...(!parameterStorePrefix ? ["PARAMETER_STORE_PREFIX"] : []),
    ...(!subnetId ? ["SUBNET_ID"] : []),
    ...(!launchTemplateId ? ["LAUNCH_TEMPLATE_ID"] : []),
  ];
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return {
    parameterStorePrefix: parameterStorePrefix!,
    subnetId: subnetId!,
    launchTemplateId: launchTemplateId!,
    logLevel,
  };
}

const config = loadConfig();

// Logger utility
function log(
  level: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const levels = ["debug", "info", "warn", "error"];
  const configLevelIndex = levels.indexOf(config.logLevel);
  const messageLevelIndex = levels.indexOf(level);

  if (messageLevelIndex >= configLevelIndex) {
    console.log(
      JSON.stringify({
        level,
        message,
        timestamp: new Date().toISOString(),
        ...(data ? { data } : {}),
      }),
    );
  }
}

// Get parameter from Parameter Store
async function getParameter(name: string): Promise<string> {
  const command = new GetParameterCommand({
    Name: name,
    WithDecryption: true,
  });

  const response = await ssmClient.send(command);

  if (!response.Parameter?.Value) {
    throw new Error(`Parameter not found: ${name}`);
  }

  return response.Parameter.Value;
}

// Save parameter to Parameter Store
async function putParameter(name: string, value: string): Promise<void> {
  const command = new PutParameterCommand({
    Name: name,
    Value: value,
    Overwrite: true,
  });

  await ssmClient.send(command);
  log("info", "Parameter updated", { name });
}

// Launch a new spot instance
async function launchNewSpotInstance(): Promise<string> {
  log("info", "Launching new spot instance", {
    launchTemplateId: config.launchTemplateId,
    subnetId: config.subnetId,
  });

  const command = new RunInstancesCommand({
    LaunchTemplate: {
      LaunchTemplateId: config.launchTemplateId,
    },
    MinCount: 1,
    MaxCount: 1,
    SubnetId: config.subnetId,
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: "stingy-vpn-server" },
          { Key: "Project", Value: "stingy-vpn" },
          { Key: "ManagedBy", Value: "Lambda" },
        ],
      },
    ],
  });

  const response = await ec2Client.send(command);

  if (!response.Instances || response.Instances.length === 0) {
    throw new Error("Failed to launch spot instance");
  }

  const newInstanceId = response.Instances[0].InstanceId;
  if (!newInstanceId) {
    throw new Error("Instance ID not returned");
  }

  log("info", "Spot instance launched successfully", {
    instanceId: newInstanceId,
  });
  return newInstanceId;
}

// Wait for instance to be running
async function waitForInstanceRunning(
  instanceId: string,
  maxAttempts = 30,
): Promise<void> {
  log("info", "Waiting for instance to be running", { instanceId });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    });

    const response = await ec2Client.send(command);
    const instance = response.Reservations?.[0]?.Instances?.[0];
    const state = instance?.State?.Name;

    log("debug", "Instance state check", { instanceId, state, attempt });

    if (state === "running") {
      log("info", "Instance is now running", { instanceId });
      return;
    }

    if (state === "terminated" || state === "shutting-down") {
      throw new Error(`Instance entered terminal state: ${state}`);
    }

    // Wait 10 seconds before next check
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }

  throw new Error(
    `Instance did not reach running state within ${maxAttempts * 10} seconds`,
  );
}

// Main handler
export const handler = async (
  event: SpotInterruptionEvent,
  context: Context,
): Promise<void> => {
  log("info", "Spot interruption event received", {
    requestId: context.awsRequestId,
    instanceId: event.detail["instance-id"],
    action: event.detail["instance-action"],
  });

  const interruptedInstanceId = event.detail["instance-id"];
  const recoveryLockParameterName = `${config.parameterStorePrefix}/recovery-locks/${interruptedInstanceId}`;
  let recoveryLockAcquired = false;

  try {
    // Get current instance ID from Parameter Store
    const currentInstanceId = await getParameter(
      `${config.parameterStorePrefix}/instance-id`,
    );

    // If the instance ID parameter is still in its initial state, ignore the event
    if (currentInstanceId === "initial") {
      log(
        "info",
        "Instance ID not initialized; ignoring spot interruption event",
        {
          interruptedInstanceId,
        },
      );
      return;
    }

    // Only process if this is our managed instance
    if (currentInstanceId !== interruptedInstanceId) {
      log("info", "Ignoring interruption for unmanaged instance", {
        interruptedInstanceId,
        currentInstanceId,
      });
      return;
    }

    // Acquire an idempotency lock so duplicate or concurrent deliveries
    // for the same interrupted instance do not launch multiple replacements.
    try {
      await ssmClient.send(
        new PutParameterCommand({
          Name: recoveryLockParameterName,
          Value: JSON.stringify({
            requestId: context.awsRequestId,
            acquiredAt: new Date().toISOString(),
          }),
          Type: "String",
          Overwrite: false,
        }),
      );
      recoveryLockAcquired = true;
    } catch (error) {
      if (error instanceof Error && error.name === "ParameterAlreadyExists") {
        log(
          "info",
          "Recovery already in progress or already completed for interrupted instance",
          {
            interruptedInstanceId,
            recoveryLockParameterName,
          },
        );
        return;
      }

      throw error;
    }

    // Launch a new spot instance
    const newInstanceId = await launchNewSpotInstance();

    // Update instance ID in Parameter Store
    await putParameter(
      `${config.parameterStorePrefix}/instance-id`,
      newInstanceId,
    );

    // Wait for instance to be running (optional, but helps ensure DDNS update works)
    await waitForInstanceRunning(newInstanceId);

    log("info", "Recovery completed successfully", {
      oldInstanceId: interruptedInstanceId,
      newInstanceId,
    });
  } catch (error) {
    if (recoveryLockAcquired) {
      try {
        await ssmClient.send(
          new DeleteParameterCommand({
            Name: recoveryLockParameterName,
          }),
        );
      } catch (cleanupError) {
        log("warn", "Failed to clean up recovery lock after error", {
          interruptedInstanceId,
          recoveryLockParameterName,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        });
      }
    }

    log("error", "Recovery failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
};
