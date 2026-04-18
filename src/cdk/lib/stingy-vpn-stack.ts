import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";

import type { Environment } from "../../config/types.js";
import { DEFAULT_CONFIG } from "../../config/types.js";
import {
  VpcConstruct,
  RecoveryLambdaConstruct,
  DdnsUpdaterLambdaConstruct,
} from "./constructs/index.js";

export interface StingyVpnStackProps extends cdk.StackProps {
  /** Environment (dev/prod) */
  readonly environment: Environment;
  /** EC2 Spot instance type (default: t4g.nano) */
  readonly spotInstanceType?: ec2.InstanceType;
  /** VPC CIDR (default: 10.0.0.0/16) */
  readonly vpcCidr?: string;
  /** WireGuard port (default: 51820) */
  readonly wireguardPort?: number;
  /** Cloudflare Zone ID */
  readonly cloudflareZoneId: string;
  /** Cloudflare DNS Record ID */
  readonly cloudflareRecordId: string;
  /** CIDR to allow SSH from (only used in dev, e.g. "203.0.113.0/32") */
  readonly sshAllowCidr?: string;
}

/**
 * Main CDK Stack for stingy-vpn
 * Deploys a low-cost VPN solution using AWS EC2 Spot Instances
 */
export class StingyVpnStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly launchTemplate: ec2.LaunchTemplate;
  public readonly recoveryFunction: cdk.aws_lambda.Function;
  public readonly ddnsUpdaterFunction: cdk.aws_lambda.Function;

  constructor(scope: Construct, id: string, props: StingyVpnStackProps) {
    super(scope, id, props);

    const {
      environment,
      spotInstanceType = ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.NANO,
      ),
      vpcCidr = DEFAULT_CONFIG.vpcCidr,
      wireguardPort = DEFAULT_CONFIG.wireguardPort,
      cloudflareZoneId,
      cloudflareRecordId,
      sshAllowCidr,
    } = props;

    const parameterStorePrefix = `/stingy-vpn/${environment}`;

    // ========================================
    // VPC and Network Resources
    // ========================================
    const enableSsh = environment === "dev" && !!sshAllowCidr;
    const vpcConstruct = new VpcConstruct(this, "Vpc", {
      vpcCidr,
      wireguardPort,
      enableSsh,
      sshAllowCidr,
    });

    this.vpc = vpcConstruct.vpc;

    // ========================================
    // Parameter Store
    // ========================================

    // Instance ID parameter (updated by Lambda)
    new ssm.StringParameter(this, "InstanceIdParam", {
      parameterName: `${parameterStorePrefix}/instance-id`,
      stringValue: "initial",
      description: "Current spot instance ID",
      tier: ssm.ParameterTier.STANDARD,
    });

    // Launch Template ID parameter
    // Note: stringValue will be set after LaunchTemplate creation below

    // ========================================
    // IAM Role for EC2
    // ========================================
    const ec2Role = new iam.Role(this, "Ec2Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "IAM role for WireGuard VPN EC2 instance",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });

    // Grant EC2 read access to Parameter Store
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${parameterStorePrefix}/*`,
        ],
      }),
    );

    // ========================================
    // EC2 Launch Template
    // ========================================
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "#!/bin/bash",
      "set -e",
      "",
      "# Update system",
      "dnf update -y",
      "",
      "# Install WireGuard",
      "dnf install -y wireguard-tools",
      "",
      "# Enable IP forwarding",
      'echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf',
      "sysctl -p",
      "",
      "# Get WireGuard configuration from Parameter Store (using IMDSv2)",
      `IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")`,
      `REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)`,
      `if ! WIREGUARD_CONFIG=$(aws ssm get-parameter --name "${parameterStorePrefix}/wireguard-config" --with-decryption --region $REGION --query 'Parameter.Value' --output text 2>&1); then`,
      '  echo "WARNING: Failed to fetch WireGuard config from Parameter Store: $WIREGUARD_CONFIG" >&2',
      '  WIREGUARD_CONFIG=""',
      "fi",
      "",
      "# Write WireGuard configuration",
      'if [ -n "$WIREGUARD_CONFIG" ]; then',
      '  echo "$WIREGUARD_CONFIG" > /etc/wireguard/wg0.conf',
      "  chmod 600 /etc/wireguard/wg0.conf",
      "",
      "  # Start WireGuard",
      "  systemctl enable wg-quick@wg0",
      "  systemctl start wg-quick@wg0",
      "else",
      '  echo "WARNING: WireGuard configuration not found in Parameter Store" >&2',
      "fi",
      "",
      "# Log startup completion",
      'echo "WireGuard VPN server initialization complete"',
    );

    this.launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      instanceType: spotInstanceType,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: vpcConstruct.securityGroup,
      userData,
      role: ec2Role,
      spotOptions: {
        interruptionBehavior: ec2.SpotInstanceInterruption.TERMINATE,
        requestType: ec2.SpotRequestType.ONE_TIME,
      },
      associatePublicIpAddress: true,
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
    });

    // Store launch template ID in Parameter Store
    // CDK token resolves launchTemplateId at deploy time, so no CustomResource is needed
    new ssm.StringParameter(this, "LaunchTemplateIdParam", {
      parameterName: `${parameterStorePrefix}/launch-template-id`,
      stringValue: this.launchTemplate.launchTemplateId!,
      description: "Launch template ID for spot instances",
      tier: ssm.ParameterTier.STANDARD,
    });

    // ========================================
    // Lambda Functions
    // ========================================

    // Recovery Lambda
    const recoveryLambda = new RecoveryLambdaConstruct(this, "RecoveryLambda", {
      environment,
      parameterStorePrefix,
      subnetId: vpcConstruct.subnet.subnetId,
      launchTemplateId: this.launchTemplate.launchTemplateId!,
      ec2RoleArn: ec2Role.roleArn,
    });
    this.recoveryFunction = recoveryLambda.function;

    // DDNS Updater Lambda
    const ddnsUpdaterLambda = new DdnsUpdaterLambdaConstruct(
      this,
      "DdnsUpdaterLambda",
      {
        environment,
        parameterStorePrefix,
        cloudflareZoneId,
        cloudflareRecordId,
      },
    );
    this.ddnsUpdaterFunction = ddnsUpdaterLambda.function;

    // ========================================
    // EventBridge Rules
    // ========================================

    // Spot Interruption Warning Rule
    const spotInterruptionRule = new events.Rule(this, "SpotInterruptionRule", {
      ruleName: `stingy-vpn-spot-interruption-${environment}`,
      description: "Triggers on EC2 Spot Instance Interruption Warning",
      eventPattern: {
        source: ["aws.ec2"],
        detailType: ["EC2 Spot Instance Interruption Warning"],
        detail: {
          "instance-id": [{ exists: true }],
        },
      },
    });

    // Add Recovery Lambda as target for spot interruption
    spotInterruptionRule.addTarget(
      new targets.LambdaFunction(this.recoveryFunction, {
        retryAttempts: 2,
      }),
    );

    // EC2 Instance State Change Rule (for running state)
    const instanceRunningRule = new events.Rule(this, "InstanceRunningRule", {
      ruleName: `stingy-vpn-instance-running-${environment}`,
      description: "Triggers when EC2 instance enters running state",
      eventPattern: {
        source: ["aws.ec2"],
        detailType: ["EC2 Instance State-change Notification"],
        detail: {
          state: ["running"],
        },
      },
    });

    // Add DDNS Updater Lambda as target for instance running
    instanceRunningRule.addTarget(
      new targets.LambdaFunction(this.ddnsUpdaterFunction, {
        retryAttempts: 2,
      }),
    );

    // ========================================
    // Tags
    // ========================================
    cdk.Tags.of(this).add("Project", "stingy-vpn");
    cdk.Tags.of(this).add("Environment", environment);
    cdk.Tags.of(this).add("ManagedBy", "CDK");

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, "VpcId", {
      value: this.vpc.vpcId,
      description: "VPC ID",
    });

    new cdk.CfnOutput(this, "LaunchTemplateId", {
      value: this.launchTemplate.launchTemplateId!,
      description: "EC2 Launch Template ID",
    });

    new cdk.CfnOutput(this, "RecoveryFunctionArn", {
      value: this.recoveryFunction.functionArn,
      description: "Recovery Lambda Function ARN",
    });

    new cdk.CfnOutput(this, "DdnsUpdaterFunctionArn", {
      value: this.ddnsUpdaterFunction.functionArn,
      description: "DDNS Updater Lambda Function ARN",
    });

    new cdk.CfnOutput(this, "ParameterStorePrefix", {
      value: parameterStorePrefix,
      description: "Parameter Store prefix for this environment",
    });
  }
}
