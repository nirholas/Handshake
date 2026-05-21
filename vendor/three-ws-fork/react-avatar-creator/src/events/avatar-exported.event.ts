import { IFrameEvent } from '../types';

export type AvatarExportedEventPayload = {
  url: string;
  userId: string;
  avatarId: string;
};

export type AvatarExportedEvent = IFrameEvent<AvatarExportedEventPayload>;
