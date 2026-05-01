import type { EventBridgeEvent, Context } from "aws-lambda";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

interface Ec2StateChangeDetail {
  readonly "instance-id": string;
  readonly state: string;
}

type Ec2StateChangeEvent = EventBridgeEvent<
  "EC2 Instance State-change Notification",
  Ec2StateChangeDetail
>;

interface EnvConfig {
  parameterStorePrefix: string;
  cloudflareZoneId: string;
  cloudflareRecordId: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

// Initialize AWS clients at module level
const ec2Client = new EC2Client({});
const ssmClient = new SSMClient({});

// Load configuration
function loadConfig(): EnvConfig {
  const parameterStorePrefix = process.env.PARAMETER_STORE_PREFIX;
  const cloudflareZoneId = process.env.CLOUDFLARE_ZONE_ID;
  const cloudflareRecordId = process.env.CLOUDFLARE_RECORD_ID;
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
    ...(!cloudflareZoneId ? ["CLOUDFLARE_ZONE_ID"] : []),
    ...(!cloudflareRecordId ? ["CLOUDFLARE_RECORD_ID"] : []),
  ];
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return {
    parameterStorePrefix: parameterStorePrefix!,
    cloudflareZoneId: cloudflareZoneId!,
    cloudflareRecordId: cloudflareRecordId!,
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

// Get EC2 instance public IP
async function getInstancePublicIp(instanceId: string): Promise<string> {
  log("debug", "Getting public IP for instance", { instanceId });

  const command = new DescribeInstancesCommand({
    InstanceIds: [instanceId],
  });

  const response = await ec2Client.send(command);
  const instance = response.Reservations?.[0]?.Instances?.[0];

  if (!instance) {
    throw new Error(`Instance not found: ${instanceId}`);
  }

  const publicIp = instance.PublicIpAddress;
  if (!publicIp) {
    throw new Error(`Instance ${instanceId} does not have a public IP`);
  }

  log("info", "Retrieved instance public IP", { instanceId, publicIp });
  return publicIp;
}

const CLOUDFLARE_TOKEN_TTL_MS = 5 * 60 * 1000;
let cachedCloudflareApiToken: string | undefined;
let cachedCloudflareApiTokenExpiresAt = 0;

async function getCloudflareApiToken(): Promise<string> {
  const now = Date.now();

  if (cachedCloudflareApiToken && now < cachedCloudflareApiTokenExpiresAt) {
    return cachedCloudflareApiToken;
  }

  const apiToken = await getParameter(
    `${config.parameterStorePrefix}/cloudflare-token`,
  );

  cachedCloudflareApiToken = apiToken;
  cachedCloudflareApiTokenExpiresAt = now + CLOUDFLARE_TOKEN_TTL_MS;

  return apiToken;
}

// Update Cloudflare DNS record
async function updateCloudflareRecord(ip: string): Promise<DnsRecord> {
  log("info", "Updating Cloudflare DNS record", {
    zoneId: config.cloudflareZoneId,
    recordId: config.cloudflareRecordId,
    ip,
  });

  const apiToken = await getCloudflareApiToken();

  const url = `https://api.cloudflare.com/client/v4/zones/${config.cloudflareZoneId}/dns_records/${config.cloudflareRecordId}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: ip,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Cloudflare API error: ${response.status} - ${errorBody}`);
  }

  const data = (await response.json()) as CloudflareResponse<DnsRecord>;

  if (!data.success) {
    throw new Error(`Cloudflare API failed: ${JSON.stringify(data.errors)}`);
  }

  log("info", "Cloudflare DNS record updated successfully", {
    recordName: data.result.name,
    content: data.result.content,
  });

  return data.result;
}

// Retry utility
async function withRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  if (maxAttempts < 1) {
    throw new Error(`withRetry requires maxAttempts >= 1, got ${maxAttempts}`);
  }

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log("warn", `Operation failed, attempt ${attempt}/${maxAttempts}`, {
        error: lastError.message,
      });

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// Main handler
export const handler = async (
  event: Ec2StateChangeEvent,
  context: Context,
): Promise<void> => {
  log("info", "EC2 state change event received", {
    requestId: context.awsRequestId,
    instanceId: event.detail["instance-id"],
    state: event.detail.state,
  });

  try {
    const instanceId = event.detail["instance-id"];

    // Only process running state
    if (event.detail.state !== "running") {
      log("info", "Ignoring non-running state", { state: event.detail.state });
      return;
    }

    // Get current managed instance ID from Parameter Store
    const managedInstanceId = await getParameter(
      `${config.parameterStorePrefix}/instance-id`,
    );

    // Only update DNS for our managed instance
    if (managedInstanceId !== instanceId) {
      log("info", "Ignoring unmanaged instance", {
        eventInstanceId: instanceId,
        managedInstanceId,
      });
      return;
    }

    // Get instance public IP with retry
    const publicIp = await withRetry(
      () => getInstancePublicIp(instanceId),
      5, // More retries since IP assignment may take time
      2000,
    );

    // Update Cloudflare DNS record with retry
    await withRetry(() => updateCloudflareRecord(publicIp), 3, 1000);

    log("info", "DDNS update completed successfully", {
      instanceId,
      publicIp,
    });
  } catch (error) {
    log("error", "DDNS update failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
};
