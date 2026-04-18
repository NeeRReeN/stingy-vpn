import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export interface VpcConstructProps {
  /** VPC CIDR block */
  readonly vpcCidr: string;
  /** WireGuard UDP port */
  readonly wireguardPort: number;
  /** Enable SSH access (TCP 22) */
  readonly enableSsh?: boolean;
  /** CIDR to allow SSH from (required when enableSsh is true) */
  readonly sshAllowCidr?: string;
}

/**
 * VPC Construct for stingy-vpn
 * Creates a simple VPC with a single public subnet for the VPN server
 */
export class VpcConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly subnet: ec2.ISubnet;

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id);

    const enableSsh = props.enableSsh ?? false;

    // Create VPC with a single public subnet
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 0, // No NAT Gateway to reduce costs
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // Get the public subnet
    this.subnet = this.vpc.publicSubnets[0];

    // Create Security Group for WireGuard
    this.securityGroup = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc: this.vpc,
      description: "Security group for WireGuard VPN server",
      allowAllOutbound: true,
    });

    // Allow WireGuard UDP traffic
    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(props.wireguardPort),
      "Allow WireGuard UDP traffic",
    );

    // Allow SSH access if enabled (requires explicit CIDR)
    if (enableSsh) {
      if (!props.sshAllowCidr) {
        throw new Error(
          "sshAllowCidr is required when enableSsh is true",
        );
      }
      this.securityGroup.addIngressRule(
        ec2.Peer.ipv4(props.sshAllowCidr),
        ec2.Port.tcp(22),
        `Allow SSH access from ${props.sshAllowCidr}`,
      );
    }

    // Add tags
    cdk.Tags.of(this.vpc).add("Name", "stingy-vpn-vpc");
    cdk.Tags.of(this.securityGroup).add("Name", "stingy-vpn-sg");
  }
}
