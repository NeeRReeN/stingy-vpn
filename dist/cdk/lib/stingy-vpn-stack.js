import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { DEFAULT_CONFIG } from "../../config/types.js";
import { VpcConstruct, RecoveryLambdaConstruct, DdnsUpdaterLambdaConstruct, } from "./constructs/index.js";
/**
 * Main CDK Stack for stingy-vpn
 * Deploys a low-cost VPN solution using AWS EC2 Spot Instances
 */
export class StingyVpnStack extends cdk.Stack {
    vpc;
    launchTemplate;
    recoveryFunction;
    ddnsUpdaterFunction;
    constructor(scope, id, props) {
        super(scope, id, props);
        const { environment, spotInstanceType = ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO), vpcCidr = DEFAULT_CONFIG.vpcCidr, wireguardPort = DEFAULT_CONFIG.wireguardPort, cloudflareZoneId, cloudflareRecordId, } = props;
        const parameterStorePrefix = `/stingy-vpn/${environment}`;
        // ========================================
        // VPC and Network Resources
        // ========================================
        const vpcConstruct = new VpcConstruct(this, "Vpc", {
            vpcCidr,
            wireguardPort,
            enableSsh: environment === "dev",
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
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
            ],
        });
        // Grant EC2 read access to Parameter Store
        ec2Role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["ssm:GetParameter", "ssm:GetParameters"],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${parameterStorePrefix}/*`,
            ],
        }));
        // ========================================
        // EC2 Launch Template
        // ========================================
        const userData = ec2.UserData.forLinux();
        userData.addCommands("#!/bin/bash", "set -e", "", "# Update system", "dnf update -y", "", "# Install WireGuard", "dnf install -y wireguard-tools", "", "# Enable IP forwarding", 'echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf', "sysctl -p", "", "# Get WireGuard configuration from Parameter Store", `REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)`, `WIREGUARD_CONFIG=$(aws ssm get-parameter --name "${parameterStorePrefix}/wireguard-config" --with-decryption --region $REGION --query 'Parameter.Value' --output text 2>/dev/null || echo "")`, "", "# Write WireGuard configuration", 'if [ -n "$WIREGUARD_CONFIG" ]; then', '  echo "$WIREGUARD_CONFIG" > /etc/wireguard/wg0.conf', "  chmod 600 /etc/wireguard/wg0.conf", "", "  # Start WireGuard", "  systemctl enable wg-quick@wg0", "  systemctl start wg-quick@wg0", "else", '  echo "WireGuard configuration not found in Parameter Store"', "fi", "", "# Log startup completion", 'echo "WireGuard VPN server initialization complete"');
        this.launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
            launchTemplateName: `stingy-vpn-${environment}`,
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
        });
        // Store launch template ID in Parameter Store
        // CDK token resolves launchTemplateId at deploy time, so no CustomResource is needed
        new ssm.StringParameter(this, "LaunchTemplateIdParam", {
            parameterName: `${parameterStorePrefix}/launch-template-id`,
            stringValue: this.launchTemplate.launchTemplateId,
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
            vpcId: this.vpc.vpcId,
            subnetId: vpcConstruct.subnet.subnetId,
            securityGroupId: vpcConstruct.securityGroup.securityGroupId,
            launchTemplateId: this.launchTemplate.launchTemplateId,
            ec2RoleArn: ec2Role.roleArn,
        });
        this.recoveryFunction = recoveryLambda.function;
        // DDNS Updater Lambda
        const ddnsUpdaterLambda = new DdnsUpdaterLambdaConstruct(this, "DdnsUpdaterLambda", {
            environment,
            parameterStorePrefix,
            cloudflareZoneId,
            cloudflareRecordId,
        });
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
        spotInterruptionRule.addTarget(new targets.LambdaFunction(this.recoveryFunction, {
            retryAttempts: 2,
        }));
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
        instanceRunningRule.addTarget(new targets.LambdaFunction(this.ddnsUpdaterFunction, {
            retryAttempts: 2,
        }));
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
            value: this.launchTemplate.launchTemplateId,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3Rpbmd5LXZwbi1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9jZGsvbGliL3N0aW5neS12cG4tc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLEdBQUcsTUFBTSxhQUFhLENBQUM7QUFDbkMsT0FBTyxLQUFLLEdBQUcsTUFBTSxxQkFBcUIsQ0FBQztBQUMzQyxPQUFPLEtBQUssR0FBRyxNQUFNLHFCQUFxQixDQUFDO0FBQzNDLE9BQU8sS0FBSyxHQUFHLE1BQU0scUJBQXFCLENBQUM7QUFDM0MsT0FBTyxLQUFLLE1BQU0sTUFBTSx3QkFBd0IsQ0FBQztBQUNqRCxPQUFPLEtBQUssT0FBTyxNQUFNLGdDQUFnQyxDQUFDO0FBSTFELE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSx1QkFBdUIsQ0FBQztBQUN2RCxPQUFPLEVBQ0wsWUFBWSxFQUNaLHVCQUF1QixFQUN2QiwwQkFBMEIsR0FDM0IsTUFBTSx1QkFBdUIsQ0FBQztBQWlCL0I7OztHQUdHO0FBQ0gsTUFBTSxPQUFPLGNBQWUsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMzQixHQUFHLENBQVU7SUFDYixjQUFjLENBQXFCO0lBQ25DLGdCQUFnQixDQUEwQjtJQUMxQyxtQkFBbUIsQ0FBMEI7SUFFN0QsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUEwQjtRQUNsRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLEVBQ0osV0FBVyxFQUNYLGdCQUFnQixHQUFHLEdBQUcsQ0FBQyxZQUFZLENBQUMsRUFBRSxDQUNwQyxHQUFHLENBQUMsYUFBYSxDQUFDLEdBQUcsRUFDckIsR0FBRyxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQ3RCLEVBQ0QsT0FBTyxHQUFHLGNBQWMsQ0FBQyxPQUFPLEVBQ2hDLGFBQWEsR0FBRyxjQUFjLENBQUMsYUFBYSxFQUM1QyxnQkFBZ0IsRUFDaEIsa0JB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RSx3QkFBd0IsRUFBRTtZQUNoRCxLQUFLLEVBQUUsSUFBSSxDQUFDLG1CQUFtQixDQUFDLFdBQVc7WUFDM0MsV0FBVyxFQUFFLGtDQUFrQztTQUNoRCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFO1lBQzlDLEtBQUssRUFBRSxvQkFBb0I7WUFDM0IsV0FBVyxFQUFFLDZDQUE2QztTQUMzRCxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1lYzJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMgc3NtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc3NtXCI7XG5pbXBvcnQgKiBhcyBldmVudHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1ldmVudHNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1ldmVudHMtdGFyZ2V0c1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHR5cGUgeyBFbnZpcm9ubWVudCB9IGZyb20gXCIuLi8uLi9jb25maWcvdHlwZXMuanNcIjtcbmltcG9ydCB7IERFRkFVTFRfQ09ORklHIH0gZnJvbSBcIi4uLy4uL2NvbmZpZy90eXBlcy5qc1wiO1xuaW1wb3J0IHtcbiAgVnBjQ29uc3RydWN0LFxuICBSZWNvdmVyeUxhbWJkYUNvbnN0cnVjdCxcbiAgRGRuc1VwZGF0ZXJMYW1iZGFDb25zdHJ1Y3QsXG59IGZyb20gXCIuL2NvbnN0cnVjdHMvaW5kZXguanNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTdGluZ3lWcG5TdGFja1Byb3BzIGV4dGVuZHMgY2RrLlN0YWNrUHJvcHMge1xuICAvKiogRW52aXJvbm1lbnQgKGRldi9wcm9kKSAqL1xuICByZWFkb25seSBlbnZpcm9ubWVudDogRW52aXJvbm1lbnQ7XG4gIC8qKiBFQzIgU3BvdCBpbnN0YW5jZSB0eXBlIChkZWZhdWx0OiB0NGcubmFubykgKi9cbiAgcmVhZG9ubHkgc3BvdEluc3RhbmNlVHlwZT86IGVjMi5JbnN0YW5jZVR5cGU7XG4gIC8qKiBWUEMgQ0lEUiAoZGVmYXVsdDogMTAuMC4wLjAvMTYpICovXG4gIHJlYWRvbmx5IHZwY0NpZHI/OiBzdHJpbmc7XG4gIC8qKiBXaXJlR3VhcmQgcG9ydCAoZGVmYXVsdDogNTE4MjApICovXG4gIHJlYWRvbmx5IHdpcmVndWFyZFBvcnQ/OiBudW1iZXI7XG4gIC8qKiBDbG91ZGZsYXJlIFpvbmUgSUQgKi9cbiAgcmVhZG9ubHkgY2xvdWRmbGFyZVpvbmVJZDogc3RyaW5nO1xuICAvKiogQ2xvdWRmbGFyZSBETlMgUmVjb3JkIElEICovXG4gIHJlYWRvbmx5IGNsb3VkZmxhcmVSZWNvcmRJZDogc3RyaW5nO1xufVxuXG4vKipcbiAqIE1haW4gQ0RLIFN0YWNrIGZvciBzdGluZ3ktdnBuXG4gKiBEZXBsb3lzIGEgbG93LWNvc3QgVlBOIHNvbHV0aW9uIHVzaW5nIEFXUyBFQzIgU3BvdCBJbnN0YW5jZXNcbiAqL1xuZXhwb3J0IGNsYXNzIFN0aW5neVZwblN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IHZwYzogZWMyLlZwYztcbiAgcHVibGljIHJlYWRvbmx5IGxhdW5jaFRlbXBsYXRlOiBlYzIuTGF1bmNoVGVtcGxhdGU7XG4gIHB1YmxpYyByZWFkb25seSByZWNvdmVyeUZ1bmN0aW9uOiBjZGsuYXdzX2xhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGRkbnNVcGRhdGVyRnVuY3Rpb246IGNkay5hd3NfbGFtYmRhLkZ1bmN0aW9uO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBTdGluZ3lWcG5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCB7XG4gICAgICBlbnZpcm9ubWVudCxcbiAgICAgIHNwb3RJbnN0YW5jZVR5cGUgPSBlYzIuSW5zdGFuY2VUeXBlLm9mKFxuICAgICAgICBlYzIuSW5zdGFuY2VDbGFzcy5UNEcsXG4gICAgICAgIGVjMi5JbnN0YW5jZVNpemUuTkFOTyxcbiAgICAgICksXG4gICAgICB2cGNDaWRyID0gREVGQVVMVF9DT05GSUcudnBjQ2lkcixcbiAgICAgIHdpcmVndWFyZFBvcnQgPSBERUZBVUxUX0NPTkZJRy53aXJlZ3VhcmRQb3J0LFxuICAgICAgY2xvdWRmbGFyZVpvbmVJZCxcbiAgICAgIGNsb3VkZmxhcmVSZWNvcmRJZCxcbiAgICB9ID0gcHJvcHM7XG5cbiAgICBjb25zdCBwYXJhbWV0ZXJTdG9yZVByZWZpeCA9IGAvc3Rpbmd5LXZwbi8ke2Vudmlyb25tZW50fWA7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVlBDIGFuZCBOZXR3b3JrIFJlc291cmNlc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCB2cGNDb25zdHJ1Y3QgPSBuZXcgVnBjQ29uc3RydWN0KHRoaXMsIFwiVnBjXCIsIHtcbiAgICAgIHZwY0NpZHIsXG4gICAgICB3aXJlZ3VhcmRQb3J0LFxuICAgICAgZW5hYmxlU3NoOiBlbnZpcm9ubWVudCA9PT0gXCJkZXZcIixcbiAgICB9KTtcblxuICAgIHRoaXMudnBjID0gdnBjQ29uc3RydWN0LnZwYztcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBQYXJhbWV0ZXIgU3RvcmVcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBJbnN0YW5jZSBJRCBwYXJhbWV0ZXIgKHVwZGF0ZWQgYnkgTGFtYmRhKVxuICAgIG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsIFwiSW5zdGFuY2VJZFBhcmFtXCIsIHtcbiAgICAgIHBhcmFtZXRlck5hbWU6IGAke3BhcmFtZXRlclN0b3JlUHJlZml4fS9pbnN0YW5jZS1pZGAsXG4gICAgICBzdHJpbmdWYWx1ZTogXCJpbml0aWFsXCIsXG4gICAgICBkZXNjcmlwdGlvbjogXCJDdXJyZW50IHNwb3QgaW5zdGFuY2UgSURcIixcbiAgICAgIHRpZXI6IHNzbS5QYXJhbWV0ZXJUaWVyLlNUQU5EQVJELFxuICAgIH0pO1xuXG4gICAgLy8gTGF1bmNoIFRlbXBsYXRlIElEIHBhcmFtZXRlclxuICAgIC8vIE5vdGU6IHN0cmluZ1ZhbHVlIHdpbGwgYmUgc2V0IGFmdGVyIExhdW5jaFRlbXBsYXRlIGNyZWF0aW9uIGJlbG93XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gSUFNIFJvbGUgZm9yIEVDMlxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCBlYzJSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiRWMyUm9sZVwiLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImVjMi5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgZGVzY3JpcHRpb246IFwiSUFNIHJvbGUgZm9yIFdpcmVHdWFyZCBWUE4gRUMyIGluc3RhbmNlXCIsXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFxuICAgICAgICAgIFwiQW1hem9uU1NNTWFuYWdlZEluc3RhbmNlQ29yZVwiLFxuICAgICAgICApLFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IEVDMiByZWFkIGFjY2VzcyB0byBQYXJhbWV0ZXIgU3RvcmVcbiAgICBlYzJSb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcInNzbTpHZXRQYXJhbWV0ZXJcIiwgXCJzc206R2V0UGFyYW1ldGVyc1wiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgYGFybjphd3M6c3NtOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpwYXJhbWV0ZXIke3BhcmFtZXRlclN0b3JlUHJlZml4fS8qYCxcbiAgICAgICAgXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRUMyIExhdW5jaCBUZW1wbGF0ZVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBjb25zdCB1c2VyRGF0YSA9IGVjMi5Vc2VyRGF0YS5mb3JMaW51eCgpO1xuICAgIHVzZXJEYXRhLmFkZENvbW1hbmRzKFxuICAgICAgXCIjIS9iaW4vYmFzaFwiLFxuICAgICAgXCJzZXQgLWVcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMgVXBkYXRlIHN5c3RlbVwiLFxuICAgICAgXCJkbmYgdXBkYXRlIC15XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIEluc3RhbGwgV2lyZUd1YXJkXCIsXG4gICAgICBcImRuZiBpbnN0YWxsIC15IHdpcmVndWFyZC10b29sc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyBFbmFibGUgSVAgZm9yd2FyZGluZ1wiLFxuICAgICAgJ2VjaG8gXCJuZXQuaXB2NC5pcF9mb3J3YXJkID0gMVwiID4+IC9ldGMvc3lzY3RsLmNvbmYnLFxuICAgICAgXCJzeXNjdGwgLXBcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMgR2V0IFdpcmVHdWFyZCBjb25maWd1cmF0aW9uIGZyb20gUGFyYW1ldGVyIFN0b3JlXCIsXG4gICAgICBgUkVHSU9OPSQoY3VybCAtcyBodHRwOi8vMTY5LjI1NC4xNjkuMjU0L2xhdGVzdC9tZXRhLWRhdGEvcGxhY2VtZW50L3JlZ2lvbilgLFxuICAgICAgYFdJUkVHVUFSRF9DT05GSUc9JChhd3Mgc3NtIGdldC1wYXJhbWV0ZXIgLS1uYW1lIFwiJHtwYXJhbWV0ZXJTdG9yZVByZWZpeH0vd2lyZWd1YXJkLWNvbmZpZ1wiIC0td2l0aC1kZWNyeXB0aW9uIC0tcmVnaW9uICRSRUdJT04gLS1xdWVyeSAnUGFyYW1ldGVyLlZhbHVlJyAtLW91dHB1dCB0ZXh0IDI+L2Rldi9udWxsIHx8IGVjaG8gXCJcIilgLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyBXcml0ZSBXaXJlR3VhcmQgY29uZmlndXJhdGlvblwiLFxuICAgICAgJ2lmIFsgLW4gXCIkV0lSRUdVQVJEX0NPTkZJR1wiIF07IHRoZW4nLFxuICAgICAgJyAgZWNobyBcIiRXSVJFR1VBUkRfQ09ORklHXCIgPiAvZXRjL3dpcmVndWFyZC93ZzAuY29uZicsXG4gICAgICBcIiAgY2htb2QgNjAwIC9ldGMvd2lyZWd1YXJkL3dnMC5jb25mXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIgICMgU3RhcnQgV2lyZUd1YXJkXCIsXG4gICAgICBcIiAgc3lzdGVtY3RsIGVuYWJsZSB3Zy1xdWlja0B3ZzBcIixcbiAgICAgIFwiICBzeXN0ZW1jdGwgc3RhcnQgd2ctcXVpY2tAd2cwXCIsXG4gICAgICBcImVsc2VcIixcbiAgICAgICcgIGVjaG8gXCJXaXJlR3VhcmQgY29uZmlndXJhdGlvbiBub3QgZm91bmQgaW4gUGFyYW1ldGVyIFN0b3JlXCInLFxuICAgICAgXCJmaVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyBMb2cgc3RhcnR1cCBjb21wbGV0aW9uXCIsXG4gICAgICAnZWNobyBcIldpcmVHdWFyZCBWUE4gc2VydmVyIGluaXRpYWxpemF0aW9uIGNvbXBsZXRlXCInLFxuICAgICk7XG5cbiAgICB0aGlzLmxhdW5jaFRlbXBsYXRlID0gbmV3IGVjMi5MYXVuY2hUZW1wbGF0ZSh0aGlzLCBcIkxhdW5jaFRlbXBsYXRlXCIsIHtcbiAgICAgIGxhdW5jaFRlbXBsYXRlTmFtZTogYHN0aW5neS12cG4tJHtlbnZpcm9ubWVudH1gLFxuICAgICAgaW5zdGFuY2VUeXBlOiBzcG90SW5zdGFuY2VUeXBlLFxuICAgICAgbWFjaGluZUltYWdlOiBlYzIuTWFjaGluZUltYWdlLmxhdGVzdEFtYXpvbkxpbnV4MjAyMyh7XG4gICAgICAgIGNwdVR5cGU6IGVjMi5BbWF6b25MaW51eENwdVR5cGUuQVJNXzY0LFxuICAgICAgfSksXG4gICAgICBzZWN1cml0eUdyb3VwOiB2cGNDb25zdHJ1Y3Quc2VjdXJpdHlHcm91cCxcbiAgICAgIHVzZXJEYXRhLFxuICAgICAgcm9sZTogZWMyUm9sZSxcbiAgICAgIHNwb3RPcHRpb25zOiB7XG4gICAgICAgIGludGVycnVwdGlvbkJlaGF2aW9yOiBlYzIuU3BvdEluc3RhbmNlSW50ZXJydXB0aW9uLlRFUk1JTkFURSxcbiAgICAgICAgcmVxdWVzdFR5cGU6IGVjMi5TcG90UmVxdWVzdFR5cGUuT05FX1RJTUUsXG4gICAgICB9LFxuICAgICAgYXNzb2NpYXRlUHVibGljSXBBZGRyZXNzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gU3RvcmUgbGF1bmNoIHRlbXBsYXRlIElEIGluIFBhcmFtZXRlciBTdG9yZVxuICAgIC8vIENESyB0b2tlbiByZXNvbHZlcyBsYXVuY2hUZW1wbGF0ZUlkIGF0IGRlcGxveSB0aW1lLCBzbyBubyBDdXN0b21SZXNvdXJjZSBpcyBuZWVkZWRcbiAgICBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCBcIkxhdW5jaFRlbXBsYXRlSWRQYXJhbVwiLCB7XG4gICAgICBwYXJhbWV0ZXJOYW1lOiBgJHtwYXJhbWV0ZXJTdG9yZVByZWZpeH0vbGF1bmNoLXRlbXBsYXRlLWlkYCxcbiAgICAgIHN0cmluZ1ZhbHVlOiB0aGlzLmxhdW5jaFRlbXBsYXRlLmxhdW5jaFRlbXBsYXRlSWQhLFxuICAgICAgZGVzY3JpcHRpb246IFwiTGF1bmNoIHRlbXBsYXRlIElEIGZvciBzcG90IGluc3RhbmNlc1wiLFxuICAgICAgdGllcjogc3NtLlBhcmFtZXRlclRpZXIuU1RBTkRBUkQsXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTGFtYmRhIEZ1bmN0aW9uc1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIFJlY292ZXJ5IExhbWJkYVxuICAgIGNvbnN0IHJlY292ZXJ5TGFtYmRhID0gbmV3IFJlY292ZXJ5TGFtYmRhQ29uc3RydWN0KHRoaXMsIFwiUmVjb3ZlcnlMYW1iZGFcIiwge1xuICAgICAgZW52aXJvbm1lbnQsXG4gICAgICBwYXJhbWV0ZXJTdG9yZVByZWZpeCxcbiAgICAgIHZwY0lkOiB0aGlzLnZwYy52cGNJZCxcbiAgICAgIHN1Ym5ldElkOiB2cGNDb25zdHJ1Y3Quc3VibmV0LnN1Ym5ldElkLFxuICAgICAgc2VjdXJpdHlHcm91cElkOiB2cGNDb25zdHJ1Y3Quc2VjdXJpdHlHcm91cC5zZWN1cml0eUdyb3VwSWQsXG4gICAgICBsYXVuY2hUZW1wbGF0ZUlkOiB0aGlzLmxhdW5jaFRlbXBsYXRlLmxhdW5jaFRlbXBsYXRlSWQhLFxuICAgICAgZWMyUm9sZUFybjogZWMyUm9sZS5yb2xlQXJuLFxuICAgIH0pO1xuICAgIHRoaXMucmVjb3ZlcnlGdW5jdGlvbiA9IHJlY292ZXJ5TGFtYmRhLmZ1bmN0aW9uO1xuXG4gICAgLy8gREROUyBVcGRhdGVyIExhbWJkYVxuICAgIGNvbnN0IGRkbnNVcGRhdGVyTGFtYmRhID0gbmV3IERkbnNVcGRhdGVyTGFtYmRhQ29uc3RydWN0KFxuICAgICAgdGhpcyxcbiAgICAgIFwiRGRuc1VwZGF0ZXJMYW1iZGFcIixcbiAgICAgIHtcbiAgICAgICAgZW52aXJvbm1lbnQsXG4gICAgICAgIHBhcmFtZXRlclN0b3JlUHJlZml4LFxuICAgICAgICBjbG91ZGZsYXJlWm9uZUlkLFxuICAgICAgICBjbG91ZGZsYXJlUmVjb3JkSWQsXG4gICAgICB9LFxuICAgICk7XG4gICAgdGhpcy5kZG5zVXBkYXRlckZ1bmN0aW9uID0gZGRuc1VwZGF0ZXJMYW1iZGEuZnVuY3Rpb247XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRXZlbnRCcmlkZ2UgUnVsZXNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBTcG90IEludGVycnVwdGlvbiBXYXJuaW5nIFJ1bGVcbiAgICBjb25zdCBzcG90SW50ZXJydXB0aW9uUnVsZSA9IG5ldyBldmVudHMuUnVsZSh0aGlzLCBcIlNwb3RJbnRlcnJ1cHRpb25SdWxlXCIsIHtcbiAgICAgIHJ1bGVOYW1lOiBgc3Rpbmd5LXZwbi1zcG90LWludGVycnVwdGlvbi0ke2Vudmlyb25tZW50fWAsXG4gICAgICBkZXNjcmlwdGlvbjogXCJUcmlnZ2VycyBvbiBFQzIgU3BvdCBJbnN0YW5jZSBJbnRlcnJ1cHRpb24gV2FybmluZ1wiLFxuICAgICAgZXZlbnRQYXR0ZXJuOiB7XG4gICAgICAgIHNvdXJjZTogW1wiYXdzLmVjMlwiXSxcbiAgICAgICAgZGV0YWlsVHlwZTogW1wiRUMyIFNwb3QgSW5zdGFuY2UgSW50ZXJydXB0aW9uIFdhcm5pbmdcIl0sXG4gICAgICAgIGRldGFpbDoge1xuICAgICAgICAgIFwiaW5zdGFuY2UtaWRcIjogW3sgZXhpc3RzOiB0cnVlIH1dLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBSZWNvdmVyeSBMYW1iZGEgYXMgdGFyZ2V0IGZvciBzcG90IGludGVycnVwdGlvblxuICAgIHNwb3RJbnRlcnJ1cHRpb25SdWxlLmFkZFRhcmdldChcbiAgICAgIG5ldyB0YXJnZXRzLkxhbWJkYUZ1bmN0aW9uKHRoaXMucmVjb3ZlcnlGdW5jdGlvbiwge1xuICAgICAgICByZXRyeUF0dGVtcHRzOiAyLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIEVDMiBJbnN0YW5jZSBTdGF0ZSBDaGFuZ2UgUnVsZSAoZm9yIHJ1bm5pbmcgc3RhdGUpXG4gICAgY29uc3QgaW5zdGFuY2VSdW5uaW5nUnVsZSA9IG5ldyBldmVudHMuUnVsZSh0aGlzLCBcIkluc3RhbmNlUnVubmluZ1J1bGVcIiwge1xuICAgICAgcnVsZU5hbWU6IGBzdGluZ3ktdnBuLWluc3RhbmNlLXJ1bm5pbmctJHtlbnZpcm9ubWVudH1gLFxuICAgICAgZGVzY3JpcHRpb246IFwiVHJpZ2dlcnMgd2hlbiBFQzIgaW5zdGFuY2UgZW50ZXJzIHJ1bm5pbmcgc3RhdGVcIixcbiAgICAgIGV2ZW50UGF0dGVybjoge1xuICAgICAgICBzb3VyY2U6IFtcImF3cy5lYzJcIl0sXG4gICAgICAgIGRldGFpbFR5cGU6IFtcIkVDMiBJbnN0YW5jZSBTdGF0ZS1jaGFuZ2UgTm90aWZpY2F0aW9uXCJdLFxuICAgICAgICBkZXRhaWw6IHtcbiAgICAgICAgICBzdGF0ZTogW1wicnVubmluZ1wiXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgREROUyBVcGRhdGVyIExhbWJkYSBhcyB0YXJnZXQgZm9yIGluc3RhbmNlIHJ1bm5pbmdcbiAgICBpbnN0YW5jZVJ1bm5pbmdSdWxlLmFkZFRhcmdldChcbiAgICAgIG5ldyB0YXJnZXRzLkxhbWJkYUZ1bmN0aW9uKHRoaXMuZGRuc1VwZGF0ZXJGdW5jdGlvbiwge1xuICAgICAgICByZXRyeUF0dGVtcHRzOiAyLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBUYWdzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIGNkay5UYWdzLm9mKHRoaXMpLmFkZChcIlByb2plY3RcIiwgXCJzdGluZ3ktdnBuXCIpO1xuICAgIGNkay5UYWdzLm9mKHRoaXMpLmFkZChcIkVudmlyb25tZW50XCIsIGVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZih0aGlzKS5hZGQoXCJNYW5hZ2VkQnlcIiwgXCJDREtcIik7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gT3V0cHV0c1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIlZwY0lkXCIsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnZwYy52cGNJZCxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlZQQyBJRFwiLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJMYXVuY2hUZW1wbGF0ZUlkXCIsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxhdW5jaFRlbXBsYXRlLmxhdW5jaFRlbXBsYXRlSWQhLFxuICAgICAgZGVzY3JpcHRpb246IFwiRUMyIExhdW5jaCBUZW1wbGF0ZSBJRFwiLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJSZWNvdmVyeUZ1bmN0aW9uQXJuXCIsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnJlY292ZXJ5RnVuY3Rpb24uZnVuY3Rpb25Bcm4sXG4gICAgICBkZXNjcmlwdGlvbjogXCJSZWNvdmVyeSBMYW1iZGEgRnVuY3Rpb24gQVJOXCIsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIkRkbnNVcGRhdGVyRnVuY3Rpb25Bcm5cIiwge1xuICAgICAgdmFsdWU6IHRoaXMuZGRuc1VwZGF0ZXJGdW5jdGlvbi5mdW5jdGlvbkFybixcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkRETlMgVXBkYXRlciBMYW1iZGEgRnVuY3Rpb24gQVJOXCIsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIlBhcmFtZXRlclN0b3JlUHJlZml4XCIsIHtcbiAgICAgIHZhbHVlOiBwYXJhbWV0ZXJTdG9yZVByZWZpeCxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlBhcmFtZXRlciBTdG9yZSBwcmVmaXggZm9yIHRoaXMgZW52aXJvbm1lbnRcIixcbiAgICB9KTtcbiAgfVxufVxuIl19