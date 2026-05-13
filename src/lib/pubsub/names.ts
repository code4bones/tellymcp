export enum EVENTS {
	sgAvatarChanged = "sgAvatarChanged",
	sgAvatarLinked = "sgAvatarLinked",
	sgProfileChanged = "sgProfileChanged",
	sgTrackChanged = "sgTrackChanged",
	cmsGitLabEvent = "cmsGitLabEvent",
	cmsMenuChanged = "cmsMenuChanged",
}

export type TEvents = keyof typeof EVENTS;
