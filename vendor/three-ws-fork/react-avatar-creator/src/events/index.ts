import { UserSetEvent } from './user-set.event';
import { AssetUnlockedEvent } from './asset-unlocked.event';
import { UserAuthorizedEvent } from './user-authorized.event';
import { AvatarExportedEvent } from './avatar-exported.event';

export type { AssetUnlockedEvent, AssetUnlockedEventPayload } from './asset-unlocked.event';
export type { AvatarExportedEvent, AvatarExportedEventPayload } from './avatar-exported.event';
export type { UserAuthorizedEvent, UserAuthorizedEventPayload } from './user-authorized.event';
export type { UserSetEvent, UserSetEventPayload } from './user-set.event';

export type AvatarCreatorEvent = UserSetEvent | AssetUnlockedEvent | UserAuthorizedEvent | AvatarExportedEvent;
