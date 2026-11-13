import type { Metadata } from 'next';
import { StudioRender } from '@/components/studio/StudioRender';
import { config } from '@/server/config';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Studio' };

/**
 * Opened by the recorder (LiveKit Egress, `customBaseUrl`) with its own hidden token: draws
 * the studio's stage full screen. Nothing here without a valid LiveKit token.
 */
export default async function StudioRenderPage(props: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await props.searchParams;
  if (!token || token.length > 4096) return null;
  // The public address: the page is https, so the internal ws:// one would be blocked.
  return <StudioRender serverUrl={config().livekitUrl} token={token} />;
}
