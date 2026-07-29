import type { Fighter } from '../types/fighter';
import { totalFollowers } from '../types/identity';

/**
 * Small helpers shared by identity, hype and business. They live apart from identity.ts
 * so that hype can use them without creating an import cycle.
 */

export function totalFollowersOf(fighter: Fighter): number {
  return fighter.social ? totalFollowers(fighter.social) : 0;
}

export { computeDrawingPower } from './identity';
