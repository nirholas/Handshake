import React, { FC } from 'react';
import { AvatarCreatorEvent, UserAuthorizedEvent, AssetUnlockedEvent, AvatarExportedEvent, UserSetEvent } from '../events';
import { AvatarCreatorRaw, AvatarCreatorRawProps } from './avatar-creator-raw';

export type AvatarCreatorProps = {
  onUserSet?: (event: UserSetEvent) => void;
  onAvatarExported?: (event: AvatarExportedEvent) => void;
  onUserAuthorized?: (event: UserAuthorizedEvent) => void;
  onAssetUnlock?: (event: AssetUnlockedEvent) => void;
} & AvatarCreatorRawProps;

/**
 * AvatarCreator is a React component that allows you to create an avatar using three.ws and receive avatar URL. It wraps AvatarCreatorRaw to provide more type safety, and to provide explicit callbacks per event type.
 * @param subdomain The subdomain of your three.ws instance.
 * @param className The css classes to apply to this iframe.
 * @param style The css styles to apply to this iframe.
 * @param config The configuration for the AvatarCreator component.
 * @param onUserSet A callback that is called when a user is set.
 * @param onAvatarExported A callback that is called when an avatar is exported.
 * @param onUserAuthorized A callback that is called when a user is authorized.
 * @param onAssetUnlock A callback that is called when an asset unlock button is pressed in RPM.
 * @returns A React component.
 */
export const AvatarCreator: FC<AvatarCreatorProps> = ({ subdomain, className, style, config, onUserSet, onAvatarExported, onUserAuthorized, onAssetUnlock }) => {
  const supportedEvents = {
    'v1.avatar.exported': onAvatarExported,
    'v1.user.set': onUserSet,
    'v1.user.authorized': onUserAuthorized,
    'v1.asset.unlock': onAssetUnlock,
  } as Record<string, any>;

  const handleEvents = (event: AvatarCreatorEvent) => {
    supportedEvents[event.eventName!]?.(event);
  };

  return <AvatarCreatorRaw subdomain={subdomain} className={className} style={style} config={config} onEventReceived={handleEvents} />;
};
