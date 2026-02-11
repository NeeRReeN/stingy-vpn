import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
export interface VpcConstructProps {
    /** VPC CIDR block */
    readonly vpcCidr: string;
    /** WireGuard UDP port */
    readonly wireguardPort: number;
    /** Enable SSH access (TCP 22) */
    readonly enableSsh?: boolean;
}
/**
 * VPC Construct for stingy-vpn
 * Creates a simple VPC with a single public subnet for the VPN server
 */
export declare class VpcConstruct extends Construct {
    readonly vpc: ec2.Vpc;
    readonly securityGroup: ec2.SecurityGroup;
    readonly subnet: ec2.ISubnet;
    constructor(scope: Construct, id: string, props: VpcConstructProps);
}
