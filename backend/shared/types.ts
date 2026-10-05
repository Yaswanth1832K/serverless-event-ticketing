// Shape of the Event item as stored in DynamoDB (see docs/03-data-model.md).
export interface EventItem {
  PK: string; // EVENT#<id>
  SK: 'META';
  entity: 'EVENT';
  eventId: string;
  name: string;
  description: string;
  venue: string;
  startsAt: string; // ISO-8601 UTC
  priceCents: number;
  capacity: number;
  sold: number;
  checkedIn: number;
  organizerId: string; // Cognito sub of the creator, used for ownership checks
  imageKey?: string;
  createdAt: string;
  updatedAt: string;
  GSI1PK: string; // USER#<organizerId>
  GSI1SK: string; // EVENT#<startsAt>#<id>
  GSI2PK: 'EVENTS';
  GSI2SK: string; // <startsAt>#<id>
}
