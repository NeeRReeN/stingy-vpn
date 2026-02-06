import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import type { Environment } from "../../../config/types.js";

export interface DdnsUpdaterLambdaConstructProps {
  /** Environment (dev/prod) */
  readonly environment: Environment;
  /** Parameter Store prefix */
  readonly parameterStorePrefix: string;
  /** Cloudflare Zone ID */
  readonly cloudflareZoneId: string;
  /** Cloudflare DNS Record ID */
  readonly cloudflareRecordId: string;
}

/**
 * DDNS Updater Lambda Construct
 * Updates Cloudflare DNS record with the new EC2 public IP
 */
export class DdnsUpdaterLambdaConstruct extends Construct {
  public readonly function: lambda.Function;

  constructor(
    scope: Construct,
    id: string,
    props: DdnsUpdaterLambdaConstructProps
  ) {
    super(scope, id);

    const logLevel = props.environment === "prod" ? "info" : "debug";

    // Create Lambda function
    this.function = new lambdaNodejs.NodejsFunction(this, "Function", {
      entry: "src/lambda/ddns-updater/index.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: {
        PARAMETER_STORE_PREFIX: props.parameterStorePrefix,
        CLOUDFLARE_ZONE_ID: props.cloudflareZoneId,
        CLOUDFLARE_RECORD_ID: props.cloudflareRecordId,
        LOG_LEVEL: logLevel,
      },
      bundling: {
        minify: props.environment === "prod",
        sourceMap: props.environment !== "prod",
        externalModules: ["@aws-sdk/*"],
      },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    // Grant Parameter Store permissions
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [`arn:aws:ssm:*:*:parameter${props.parameterStorePrefix}/*`],
      })
    );

    // Grant EC2 describe permissions to get instance public IP
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:DescribeInstances"],
        resources: ["*"],
      })
    );

    // Add tags
    cdk.Tags.of(this.function).add("Function", "ddns-updater");
  }
}
