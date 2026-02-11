import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import type { Environment } from "../../config/types.js";
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
}
/**
 * Main CDK Stack for stingy-vpn
 * Deploys a low-cost VPN solution using AWS EC2 Spot Instances
 */
export declare class StingyVpnStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;
    readonly launchTemplate: ec2.LaunchTemplate;
    readonly recoveryFunction: cdk.aws_lambda.Function;
    readonly ddnsUpdaterFunction: cdk.aws_lambda.Function;
    constructor(scope: Construct, id: string, props: StingyVpnStackProps);
}
