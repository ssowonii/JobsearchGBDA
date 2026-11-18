import { JobDetail, ProfileDialog } from '@/components/Dialogs';
import { DreamPanel, Header, Tabs } from '@/components/Header';
import { HubProvider } from '@/components/HubProvider';
import { ReviewDialog } from '@/components/ReviewDialog';

export default function HubLayout({ children }: { children: React.ReactNode }) {
  return (
    <HubProvider>
      <Header />
      <DreamPanel />
      <Tabs />
      {children}
      <JobDetail />
      <ProfileDialog />
      <ReviewDialog />
    </HubProvider>
  );
}
