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
  /** Subnet ID for spot instance launch */
  readonly subnetId: string;
  /** Launch template ID */
  readonly launchTemplateId: string;
  /** EC2 instance role ARN (for iam:PassRole restriction) */
  readonly ec2RoleArn: string;
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
    props: RecoveryLambdaConstructProps,
  ) {
    super(scope, id);

    const logLevel = props.environment === "prod" ? "info" : "debug";

    // Create Lambda function
    this.function = new lambdaNodejs.NodejsFunction(this, "Function", {
      entry: "src/lambda/recovery/index.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(7),
      memorySize: 256,
      environment: {
        PARAMETER_STORE_PREFIX: props.parameterStorePrefix,
        SUBNET_ID: props.subnetId,
        LAUNCH_TEMPLATE_ID: props.launchTemplateId,
        LOG_LEVEL: logLevel,
      },
      bundling: {
        minify: props.environment === "prod",
        sourceMap: props.environment !== "prod",
      },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    });

    // Grant Parameter Store permissions
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${props.parameterStorePrefix}/*`,
        ],
      }),
    );

    // Grant EC2 permissions for spot instance management
    // Note: ec2:RunInstances needs broad resources because tags are applied at launch time,
    // not on pre-existing resources. We scope ec2:CreateTags and Describe* where possible.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:RunInstances"],
        resources: [
          `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:launch-template/*`,
          `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/*`,
          `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:volume/*`,
          `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:network-interface/*`,
          `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:security-group/*`,
          `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:subnet/*`,
          `arn:aws:ec2:${cdk.Stack.of(this).region}::image/*`,
        ],
      }),
    );

    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:CreateTags"],
        resources: [
          `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:instance/*`,
          `arn:aws:ec2:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:volume/*`,
        ],
        conditions: {
          StringEquals: {
            "ec2:CreateAction": "RunInstances",
          },
        },
      }),
    );

    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:DescribeInstances", "ec2:DescribeSpotInstanceRequests"],
        resources: ["*"],
      }),
    );

    // Grant EC2 launch template permissions
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:DescribeLaunchTemplates"],
        resources: ["*"],
      }),
    );

    // Grant IAM pass role permission for EC2 instance profile
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [props.ec2RoleArn],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "ec2.amazonaws.com",
          },
        },
      }),
    );

    // Add tags
    cdk.Tags.of(this.function).add("Function", "recovery-handler");
  }
}
