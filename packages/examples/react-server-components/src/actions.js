'use server';

import { setServerState } from "./ServerState";

let likeCount = 0;

export async function like(...args) {
  console.log('Like', ...args);
  setServerState(`Liked ${++likeCount} times!`);
  return 'Liked';
}
