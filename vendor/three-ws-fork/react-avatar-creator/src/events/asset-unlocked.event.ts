import { IFrameEvent } from '../types';

export type AssetUnlockedEventPayload = {
  userId: string;
  assetId: string;
};

export type AssetUnlockedEvent = IFrameEvent<AssetUnlockedEventPayload>;
