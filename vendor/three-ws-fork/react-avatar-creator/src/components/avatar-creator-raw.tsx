import React, { CSSProperties, FC, useEffect, useRef } from 'react';
import { AvatarCreatorConfig } from '../types';
import { JSONTryParse } from '../utils';
import { AvatarCreatorEvent } from '../events';
import { useAvatarCreatorUrl } from '../hooks/use-avatar-creator-url';

const MESSAGE_EVENT = 'message';
const THREEWS_TARGET = 'threews';
const IFRAME_READY_EVENT = 'v1.frame.ready';

export type AvatarCreatorRawProps = {
  subdomain: string;
  className?: string;
  style?: CSSProperties;
  config?: AvatarCreatorConfig;
};

export type EventReceivedProps = {
  onEventReceived?: (event: AvatarCreatorEvent) => void;
};

/**
 * AvatarCreatorRaw is a React component that allows you to create an avatar using three.ws and receive avatar URL. It exposes the raw events in one callback to allow you to write more custom logic around the event handling.
 * @param subdomain The subdomain of your three.ws instance.
 * @param className The css classes to apply to this iframe.
 * @param style The css styles to apply to this iframe.
 * @param avatarCreatorConfig The configuration for the AvatarCreator component.
 * @param onEventReceived A callback that is called when an avatar creator event is received.
 * @returns A React component.
 */
export const AvatarCreatorRaw: FC<AvatarCreatorRawProps & EventReceivedProps> = ({ subdomain, className, style, config, onEventReceived }) => {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const url = useAvatarCreatorUrl(subdomain, config);

  const subscribeToAvatarCreatorEvents = () => {
    if (!frameRef.current?.contentWindow) return;

    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({
        target: THREEWS_TARGET,
        type: 'subscribe',
        eventName: 'v1.**',
      }),
      '*'
    );
  };

  const subscribe = (event: MessageEvent) => {
    const avatarCreatorEvent = JSONTryParse<AvatarCreatorEvent>(event.data);

    if (avatarCreatorEvent?.source !== THREEWS_TARGET) return;

    if (avatarCreatorEvent?.eventName === IFRAME_READY_EVENT) {
      subscribeToAvatarCreatorEvents();
      return;
    }

    onEventReceived?.(avatarCreatorEvent);
  };

  useEffect(() => {
    window.addEventListener(MESSAGE_EVENT, subscribe);

    return () => {
      window.removeEventListener(MESSAGE_EVENT, subscribe);
    };
  }, []);

  return <iframe title="three.ws" ref={frameRef} src={url} style={style} className={className} allow="camera *; clipboard-write" />;
};
