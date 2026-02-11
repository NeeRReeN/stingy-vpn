import type { EventBridgeEvent, Context } from "aws-lambda";
interface SpotInterruptionDetail {
    "instance-id": string;
    "instance-action": string;
}
type SpotInterruptionEvent = EventBridgeEvent<"EC2 Spot Instance Interruption Warning", SpotInterruptionDetail>;
export declare const handler: (event: SpotInterruptionEvent, context: Context) => Promise<void>;
export {};
