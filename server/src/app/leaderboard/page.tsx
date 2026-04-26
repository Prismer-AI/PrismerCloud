import { redirect } from 'next/navigation';

export default function LeaderboardPage() {
  redirect('/evolution?tab=agents');
}
