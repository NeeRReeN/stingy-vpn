import type { EventBridgeEvent, Context } from "aws-lambda";
interface Ec2StateChangeDetail {
    "instance-id": string;
    state: string;
}
type Ec2StateChangeEvent = EventBridgeEvent<"EC2 Instance State-change Notification", Ec2StateChangeDetail>;
export declare const handler: (event: Ec2StateChangeEvent, context: Context) => Promise<void>;
export {};
