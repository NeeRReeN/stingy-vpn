---
applyTo: "**/cdk/**/*.ts,**/lib/**/*.ts,**/*-stack.ts"
description: "AWS CDK スタック開発のベストプラクティス"
---

# AWS CDK 開発ガイドライン

## 基本方針

- AWS CDK v2 を使用
- L2 Construct を優先（L1 は必要な場合のみ）
- インフラをコードとして明確に表現

## プロジェクト構造

```
src/cdk/
├── bin/
│   └── app.ts              # CDK アプリケーションのエントリポイント
├── lib/
│   ├── stingy-vpn-stack.ts # メインスタック
│   └── constructs/         # 再利用可能な Construct
│       ├── vpc-construct.ts
│       └── lambda-construct.ts
└── config/
    └── environments.ts     # 環境別設定
```

## スタック定義

### 基本パターン

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

    // リソース定義
  }
}
```

### Props の設計

```typescript
// ✅ 推奨: 明確な Props インターフェース
export interface LambdaConstructProps {
  /** Lambda 関数名 */
  readonly functionName: string;
  /** タイムアウト（デフォルト: 30秒） */
  readonly timeout?: cdk.Duration;
  /** 環境変数 */
  readonly environment?: Record<string, string>;
}

// デフォルト値は Construct 内で設定
const timeout = props.timeout ?? cdk.Duration.seconds(30);
```

## リソース命名

```typescript
// ✅ 論理的な名前を使用（物理名は CDK に任せる）
const bucket = new s3.Bucket(this, "ConfigBucket", {
  // removalPolicy は環境に応じて設定
  removalPolicy:
    props.environment === "prod"
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY,
});

// 物理名が必要な場合は明示的に
const parameterName = `/stingy-vpn/${props.environment}/instance-id`;
```

## IAM ポリシー

### 最小権限の原則

```typescript
// ✅ 推奨: リソースベースで最小限の権限
bucket.grantRead(lambdaFunction);
parameter.grantRead(lambdaFunction);

// ✅ 特定アクションのみ許可
lambdaFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ["ec2:DescribeInstances", "ec2:RunInstances"],
    resources: ["*"], // EC2 は ARN 指定が難しい場合あり
    conditions: {
      StringEquals: {
        "ec2:ResourceTag/Project": "stingy-vpn",
      },
    },
  })
);

// ❌ 避ける: 過剰な権限
lambdaFunction.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["ec2:*"],
    resources: ["*"],
  })
);
```

## Lambda 関数の定義

```typescript
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";

// ✅ NodejsFunction で TypeScript を直接バンドル
const recoveryFunction = new lambdaNodejs.NodejsFunction(
  this,
  "RecoveryFunction",
  {
    entry: "src/lambda/recovery/index.ts",
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_20_X,
    architecture: lambda.Architecture.ARM_64, // コスト効率
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

## EC2 スポットインスタンス

```typescript
// スポットインスタンスの起動テンプレート
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

## EventBridge ルール

```typescript
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";

// スポット中断イベントのルール
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

// パラメータの作成
const instanceIdParam = new ssm.StringParameter(this, "InstanceIdParam", {
  parameterName: `/stingy-vpn/${props.environment}/instance-id`,
  stringValue: "initial", // 初期値（Lambda で更新）
  description: "現在のスポットインスタンス ID",
  tier: ssm.ParameterTier.STANDARD,
});

// SecureString は手動作成を推奨（API トークンなど）
// CDK では参照のみ
const apiToken = ssm.StringParameter.fromSecureStringParameterAttributes(
  this,
  "CloudflareToken",
  {
    parameterName: `/stingy-vpn/${props.environment}/cloudflare-token`,
  }
);
```

## タグ付け

```typescript
// スタック全体にタグを適用
cdk.Tags.of(this).add("Project", "stingy-vpn");
cdk.Tags.of(this).add("Environment", props.environment);
cdk.Tags.of(this).add("ManagedBy", "CDK");
```

## テスト

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

## デプロイ

```bash
# 差分確認（必ず実行）
npx cdk diff

# デプロイ
npx cdk deploy

# 特定スタックのみ
npx cdk deploy StingyVpnStack-dev
```
