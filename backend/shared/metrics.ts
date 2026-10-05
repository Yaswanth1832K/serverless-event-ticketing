// Custom CloudWatch metrics written as Embedded Metric Format (EMF) log lines.
// CloudWatch turns these into metrics automatically, so there is no PutMetricData call, no extra
// IAM permission and no added latency.
//
// The line is written with process.stdout.write, NOT console.log. With Lambda's JSON log format
// console.log wraps its argument as an escaped string inside a "message" field, and CloudWatch
// then does not recognise it as EMF (verified on the deployed stack: no metrics appeared).
export type MetricName =
  | 'BookingSuccess'
  | 'BookingRejectedSoldOut'
  | 'BookingConflictRetry'
  | 'CheckInSuccess'
  | 'CheckInRejected'
  | 'CheckInCounted'
  | 'StreamDuplicateSkipped';

export function putMetric(name: MetricName, value = 1): void {
  process.stdout.write(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          { Namespace: 'TicketingPlatform', Dimensions: [[]], Metrics: [{ Name: name, Unit: 'Count' }] },
        ],
      },
      [name]: value,
    }) + '\n',
  );
}
