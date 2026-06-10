'use client';

/**
 * "+ New skill" — release201/24 §Phase1b (Path B).
 *
 * This used to be a static multi-field form. It is now a thin wrapper around
 * {@link ConversationalWizard}: a full inline conversational wizard where the
 * agent asks back (free text + structured decision cards) to converge an
 * AuthoringSpec, then fires ONE `skill-authoring` task and tracks the real
 * draft + eval run in a live right-side preview.
 *
 * Props signature is intentionally unchanged so authoring-view.tsx keeps
 * working without modification (`onSubmitted({ taskId, agentId, agentOnline })`).
 */

import { ConversationalWizard, type ConversationalWizardProps } from './new-skill-dialog/conversational-wizard';
import type { DraftInputMode } from './new-skill-dialog/helpers';

export type { DraftInputMode };

export type NewSkillDialogProps = ConversationalWizardProps;

export function NewSkillDialog(props: NewSkillDialogProps) {
  return <ConversationalWizard {...props} />;
}
