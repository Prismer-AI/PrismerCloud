'use client';

/**
 * ApprovalCard kind='skill-publish' Studio variant — release201/08 §9.2.1,
 * release201/13 §3.3 (S22).
 *
 * Renders the 9-section EvidencePanel for any pending skill-publish
 * approval. The workspace approval-card.tsx short-circuits before reaching
 * here (see `skillVariantInWorkspace` guard); this wrapper is mounted only
 * inside `/evolution → Studio → Skills → Lifecycle`.
 *
 * The Studio Lifecycle sub-tab also renders EvidencePanel directly for the
 * actively selected skill; this wrapper is the entry point when the
 * approval queue surfaces a pending decision elsewhere on the same page.
 */

import { useEffect, useState } from 'react';
import { EvidencePanel } from './evidence-panel';
import { type SkillDetail, fetchSkillDetail } from '../types';

interface ApprovalCardSkillPublishProps {
  isDark: boolean;
  skillId: string;
}

export function ApprovalCardSkillPublish({ isDark, skillId }: ApprovalCardSkillPublishProps) {
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchSkillDetail(skillId).then((d) => {
      if (cancelled) return;
      setSkill(d);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  return (
    <div data-testid="approval-card-skill-publish-studio">
      <EvidencePanel isDark={isDark} skill={skill} loading={loading} showReviewerActions={true} />
    </div>
  );
}
