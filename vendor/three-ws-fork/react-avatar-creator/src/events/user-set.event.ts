import { IFrameEvent } from '../types';

export type UserSetEventPayload = {
  id: string;
};

export type UserSetEvent = IFrameEvent<UserSetEventPayload>;
