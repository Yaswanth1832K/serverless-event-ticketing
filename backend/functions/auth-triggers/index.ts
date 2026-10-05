import type { PreSignUpTriggerEvent, PostConfirmationTriggerEvent } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { log } from '../../shared/logger';

const cognito = new CognitoIdentityProviderClient({});

// Only these two roles can be self-selected at signup. Staff is never self-assigned.
export const SELF_SERVICE_ROLES = ['Attendee', 'Organizer'] as const;
type SelfServiceRole = (typeof SELF_SERVICE_ROLES)[number];

// Missing role means Attendee. Any other value (Staff, Admin, junk) is rejected outright.
export function assertSelfServiceRole(requested: string | undefined): SelfServiceRole {
  if (requested === undefined || requested === '') return 'Attendee';
  if ((SELF_SERVICE_ROLES as readonly string[]).includes(requested)) {
    return requested as SelfServiceRole;
  }
  throw new Error('Invalid role');
}

// Second line of defence at PostConfirmation: anything unexpected falls back to Attendee.
export function groupForRole(requested: string | undefined): SelfServiceRole {
  return requested === 'Organizer' ? 'Organizer' : 'Attendee';
}

type TriggerEvent = PreSignUpTriggerEvent | PostConfirmationTriggerEvent;

// One Lambda serves two Cognito triggers, chosen by triggerSource.
// Authorization everywhere else uses the cognito:groups claim, never custom:role, so editing
// custom:role after signup cannot change anyone's permissions.
export async function handler(event: TriggerEvent): Promise<TriggerEvent> {
  if (event.triggerSource === 'PreSignUp_SignUp') {
    const pre = event as PreSignUpTriggerEvent;
    try {
      assertSelfServiceRole(pre.request.userAttributes['custom:role']);
    } catch (err) {
      log.warn('signup rejected: unauthorized role requested', {
        requested: pre.request.userAttributes['custom:role'],
      });
      throw err;
    }
    // Demo simplification: no email verification step, accounts are auto-confirmed.
    pre.response.autoConfirmUser = true;
    return pre;
  }

  if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
    const group = groupForRole(event.request.userAttributes['custom:role']);
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
        GroupName: group,
      }),
    );
    log.info('user added to group', { group });
  }
  return event;
}
