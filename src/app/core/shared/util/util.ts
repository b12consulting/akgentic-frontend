import { Pipe, PipeTransform } from '@angular/core';
import { upperFirst } from 'lodash';

@Pipe({
  name: 'displayActorName',
})
export class DisplayActorNamePipe implements PipeTransform {
  transform(name: string | null | undefined): string {
    return displayActorName(name ?? '');
  }
}

/** The workspace tool's actor: `#Workspace-<scope>/<kind>/<leaf>`. */
const WORKSPACE_ACTOR = /^#?Workspace-(.+)$/;

/**
 * An actor name as the chat shows it. The workspace actor is named after its
 * whole path, and only the leaf means anything to a reader:
 * `#Workspace-anonymous/_meta/folder-Documents` reads `Workspace/folder-Documents`.
 * Every other name comes back unchanged, and so does a workspace name whose
 * path has no leaf. Display only: never match or look up by the result.
 */
export function displayActorName(name: string): string {
  const match = WORKSPACE_ACTOR.exec(name);
  if (!match) return name;
  const segments = match[1].split('/');
  const leaf = segments[segments.length - 1];
  return leaf === '' ? name : `Workspace/${leaf}`;
}

/** An actor's avatar initial, taken from its display name. */
export function actorInitial(name: string | null | undefined): string {
  const bare = displayActorName(name ?? '').replace(/^@/, '').trim();
  return bare ? bare.slice(0, 1).toUpperCase() : '·';
}

export function makeAgentNameUserFriendly(agentName: string): string {
  const display = displayActorName(agentName);
  if (display !== agentName) return display;
  // Given an actorName like "NAME-ROLE-BATCH-N-TASK-M"
  // Split the actorName by '-' and take the first part as the name
  const name = agentName.split('-')[0];
  // Split the actorName by '-' and take the second part as the role
  const role: string | undefined = upperFirst(
    agentName.split('-')[1]?.split('_')?.join(' ')
  );
  // Construct the label for the node
  const label = name + (role ? ` [${role}]` : '');
  return label;
}
