import { track } from '@amplitude/analytics-browser';

export function trackEvent(event: string, data?: Record<string, any>) {
  try {
    track(event, data);
  } catch (error) {
    console.error('Failed to track event', error);
  }
}
