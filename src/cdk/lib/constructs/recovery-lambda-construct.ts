import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import type { Environment } from "../../../config/types.js";

export interface RecoveryLambdaConstructProps {
  /** Environment (dev/prod) */
  readonly environment: Environment;
  /** Parameter Store prefix */
  readonly parameterStorePrefix: string;
  /** VPC ID for EC2 operations */
  readonly vpcId: string;
  /** Subnet ID for spot instance launch */
  readonly subnetId: string;
  /** Security group ID for spot instance */
  readonly securityGroupId: string;
  /** Launch template ID */
  readonly launchTemplateId: string;
}

/**
 * Recovery Lambda Construct
 * Handles spot instance interruption and launches a new instance
 */
export class RecoveryLambdaConstruct extends Construct {
  public readonly function: lambda.Function;

  constructor(
    scope: Construct,
    id: string,
    props: RecoveryLambdaConstructProps
  ) {
    super(scope, id);

    const logLevel = props.environment === "prod" ? "info" : "debug";

    // Create Lambda function
    this.function = new lambdaNodejs.NodejsFunction(this, "Function", {
      entry: "src/lambda/recovery/index.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        PARAMETER_STORE_PREFIX: props.parameterStorePrefix,
        VPC_ID: props.vpcId,
        SUBNET_ID: props.subnetId,
        SECURITY_GROUP_ID: props.securityGroupId,
        LAUNCH_TEMPLATE_ID: props.launchTemplateId,
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
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
        resources: [`arn:aws:ssm:*:*:parameter${props.parameterStorePrefix}/*`],
      })
    );

    // Grant EC2 permissions for spot instance management
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:RunInstances",
          "ec2:CreateTags",
          "ec2:DescribeInstances",
          "ec2:DescribeSpotInstanceRequests",
        ],
        resources: ["*"],
      })
    );

    // Grant EC2 launch template permissions
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:DescribeLaunchTemplates"],
        resources: ["*"],
      })
    );

    // Grant IAM pass role permission for EC2 instance profile
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "ec2.amazonaws.com",
          },
        },
      })
    );

    // Add tags
    cdk.Tags.of(this.function).add("Function", "recovery-handler");
  }
}
