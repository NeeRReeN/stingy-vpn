---
applyTo: "**/cdk/**/*.ts,**/lib/**/*.ts,**/*-stack.ts"
description: "AWS CDK stack development best practices"
---

# AWS CDK Development Guidelines

## Core Principles

- Use AWS CDK v2
- Prefer L2 Constructs (use L1 only when necessary)
- Express infrastructure as code clearly

## Project Structure

```
src/cdk/
├── bin/
│   └── app.ts              # CDK application entry point
├── lib/
│   ├── stingy-vpn-stack.ts # Main stack
│   └── constructs/         # Reusable Constructs
│       ├── vpc-construct.ts
│       └── lambda-construct.ts
└── config/
    └── environments.ts     # Environment-specific configuration
```

## Stack Definition

### Basic Pattern

```typescript
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";

export interface StingyVpnStackProps extends cdk.StackProps {
  readonly environment: "dev" | "prod";
  readonly spotInstanceType?: ec2.InstanceType;
}

export class StingyVpnStack extends cdk.Stack {
  public readonly recoveryFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: StingyVpnStackProps) {
    super(scope, id, props);

    // Resource definitions
  }
}
```

### Props Design

```typescript
// Recommended: clear Props interface
export interface LambdaConstructProps {
  /** Lambda function name */
  readonly functionName: string;
  /** Timeout (default: 30 seconds) */
  readonly timeout?: cdk.Duration;
  /** Environment variables */
  readonly environment?: Record<string, string>;
}

// Set default values within the Construct
const timeout = props.timeout ?? cdk.Duration.seconds(30);
```

## Resource Naming

```typescript
// Use logical names (let CDK handle physical names)
const bucket = new s3.Bucket(this, "ConfigBucket", {
  // Set removalPolicy based on environment
  removalPolicy:
    props.environment === "prod"
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY,
});

// Be explicit when physical names are needed
const parameterName = `/stingy-vpn/${props.environment}/instance-id`;
```

## IAM Policies

### Principle of Least Privilege

```typescript
// Recommended: minimum permissions based on resources
bucket.grantRead(lambdaFunction);
parameter.grantRead(lambdaFunction);

// Allow only specific actions
lambdaFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["ec2:DescribeInstances", "ec2:RunInstances"],
    resources: ["*"], // EC2 may be difficult to specify ARN
    conditions: {
      StringEquals: {
        "ec2:ResourceTag/Project": "stingy-vpn",
      },
    },
  })
);

// Avoid: excessive permissions
lambdaFunction.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["ec2:*"],
    resources: ["*"],
  })
);
```

## Lambda Function Definition

```typescript
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";

// Bundle TypeScript directly with NodejsFunction
const recoveryFunction = new lambdaNodejs.NodejsFunction(
  this,
  "RecoveryFunction",
  {
    entry: "src/lambda/recovery/index.ts",
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_20_X,
    architecture: lambda.Architecture.ARM_64, // Cost efficiency
    timeout: cdk.Duration.minutes(5),
    memorySize: 256,
    environment: {
      PARAMETER_STORE_PREFIX: `/stingy-vpn/${props.environment}`,
      LOG_LEVEL: props.environment === "prod" ? "info" : "debug",
    },
    bundling: {
      minify: true,
      sourceMap: props.environment !== "prod",
    },
  }
);
```

## EC2 Spot Instances

```typescript
// Launch template for spot instances
const launchTemplate = new ec2.LaunchTemplate(this, "SpotTemplate", {
  instanceType:
    props.spotInstanceType ??
    ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
  machineImage: ec2.MachineImage.latestAmazonLinux2023({
    cpuType: ec2.AmazonLinuxCpuType.ARM_64,
  }),
  securityGroup,
  userData,
  spotOptions: {
    interruptionBehavior: ec2.SpotInstanceInterruption.TERMINATE,
    requestType: ec2.SpotRequestType.ONE_TIME,
  },
});
```

## EventBridge Rules

```typescript
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";

// Rule for spot interruption events
const spotInterruptionRule = new events.Rule(this, "SpotInterruptionRule", {
  eventPattern: {
    source: ["aws.ec2"],
    detailType: ["EC2 Spot Instance Interruption Warning"],
    detail: {
      "instance-id": [{ exists: true }],
    },
  },
});

spotInterruptionRule.addTarget(new targets.LambdaFunction(recoveryFunction));
```

## Parameter Store

```typescript
import * as ssm from "aws-cdk-lib/aws-ssm";

// Create parameter
const instanceIdParam = new ssm.StringParameter(this, "InstanceIdParam", {
  parameterName: `/stingy-vpn/${props.environment}/instance-id`,
  stringValue: "initial", // Initial value (updated by Lambda)
  description: "Current spot instance ID",
  tier: ssm.ParameterTier.STANDARD,
});

// SecureString is recommended to be created manually (API tokens, etc.)
// Only reference in CDK
const apiToken = ssm.StringParameter.fromSecureStringParameterAttributes(
  this,
  "CloudflareToken",
  {
    parameterName: `/stingy-vpn/${props.environment}/cloudflare-token`,
  }
);
```

## Tagging

```typescript
// Apply tags to entire stack
cdk.Tags.of(this).add("Project", "stingy-vpn");
cdk.Tags.of(this).add("Environment", props.environment);
cdk.Tags.of(this).add("ManagedBy", "CDK");
```

## Testing

```typescript
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { StingyVpnStack } from "../lib/stingy-vpn-stack";

describe("StingyVpnStack", () => {
  const app = new cdk.App();
  const stack = new StingyVpnStack(app, "TestStack", {
    environment: "dev",
  });
  const template = Template.fromStack(stack);

  test("Lambda function is created with correct runtime", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs20.x",
      Architectures: ["arm64"],
    });
  });

  test("EventBridge rule targets Lambda", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({
        source: ["aws.ec2"],
      }),
    });
  });
});
```

## Deployment

```bash
# Check diff (always run)
npx cdk diff

# Deploy
npx cdk deploy

# Deploy specific stack only
npx cdk deploy StingyVpnStack-dev
```
