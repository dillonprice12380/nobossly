import { Screen } from '@/components/Screen';
import { SiteView } from '@/components/SiteView';

export default function Tab() {
  return (
    <Screen>
      <SiteView path="/quests" tab="quests" />
    </Screen>
  );
}
