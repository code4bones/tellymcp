// import { TEvents, EVENTS } from "./names";
import PubBuilder from "./pubbuilder";

export type EventsAction = {
	event: string;
	id: string;
	payload: unknown;
};

export { PubBuilder };
