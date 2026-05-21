export type BodyType = 'halfbody' | 'fullbody';

export type Language = 'en' | 'en-IE' | 'de' | 'fr' | 'es' | 'es-MX' | 'it' | 'pt' | 'pt-BR' | 'tr' | 'ja' | 'kr' | 'ch';

export type AvatarCreatorConfig = {
  clearCache?: boolean;
  bodyType?: BodyType;
  quickStart?: boolean;
  language?: Language;
  token?: string;
  avatarId?: string;
};

export type IFrameEvent<TPayload> = {
  eventName?: string;
  source?: string;
  data: TPayload;
};
