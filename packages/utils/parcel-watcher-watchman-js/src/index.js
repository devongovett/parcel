import {ParcelWatcherWatchmanJS} from './wrapper';

const wrapper = new ParcelWatcherWatchmanJS();

export const writeSnapshot = wrapper.writeSnapshot.bind(wrapper);
export const getEventsSince = wrapper.getEventsSince.bind(wrapper);
export const subscribe = wrapper.subscribe.bind(wrapper);
export const unsubscribe = wrapper.unsubscribe.bind(wrapper);
