import { IFrameEvent } from '../types';

export type UserAuthorizedEventPayload = {
  url: string;
};

export type UserAuthorizedEvent = IFrameEvent<UserAuthorizedEventPayload>;
