import {
  connect,
  expect,
  parseLayerTree,
  type AriaNode,
  type Capabilities,
  type NetworkEventData,
  type Page,
  type RenderPerfResult,
} from 'juce-webview-agent-bridge';
import {
  CLIENT_PROTOCOL_VERSION,
  DEFAULT_PORT,
  clientVersion,
  loadDiscovery,
  type BridgeCapabilities,
} from 'juce-webview-agent-bridge/shared';

async function exercisePublicTypes(page: Page): Promise<void> {
  const bpm = await page.backend<number>('getBpm');
  const state = await page.evaluate<{ playing: boolean }>('window.transportState');
  const settled = await page.pollStable<number>('window.bpm');
  const response = await page.waitForResponse<NetworkEventData>('/api/save');
  const tree: AriaNode | AriaNode[] = await page.ariaSnapshot();
  const perf: RenderPerfResult = await page.measureRenderPerf({ durationMs: 1000 });

  await page.getByTestId('bpm').fill(bpm, { enter: true });
  await page.locator('.knob').drag({ dy: -40, pointer: true });
  await expect(page.locator('text=Saved')).toBeVisible({ timeout: 1000 });
  await expect.poll(() => page.backend<number>('getBpm')).toBeGreaterThan(0);
  page.on('net', (event) => void event.data);

  // Capabilities is the shared handshake shape; page.caps is null when the host
  // could not answer it, so consumers must narrow before reading a field.
  const caps: Capabilities = await page.capabilities();
  const negotiated: BridgeCapabilities | null = page.caps;
  const hostModule: string = negotiated?.moduleVersion ?? 'unknown';

  void [state, settled, response, tree, perf, caps.ops, hostModule,
       CLIENT_PROTOCOL_VERSION, clientVersion(), parseLayerTree(''), DEFAULT_PORT, loadDiscovery()];
}

void connect({ activate: 'My App' }).then(exercisePublicTypes);
