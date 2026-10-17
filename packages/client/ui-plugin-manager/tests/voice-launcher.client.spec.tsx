// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceInputLauncher, type VoiceInputLauncherProps } from '../src/client/VoiceInputLauncher.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const dictionary: Readonly<Record<string, string>> = en
const t: VoiceInputLauncherProps['t'] = key => dictionary[key] ?? key

describe('voice setup launcher', () => {
  it('explains local preparation and editable text before enabling and never starts on its own', async () => {
    const openVoiceSetup = vi.fn<VoiceInputLauncherProps['openVoiceSetup']>(async () => 'opened')
    render(<VoiceInputLauncher locked={false} openVoiceSetup={openVoiceSetup} t={t} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(openVoiceSetup).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en['voiceLauncher.trigger'] }))
    expect(screen.getByRole('dialog').textContent).toMatchInlineSnapshot('"Enable voice inputFirst use requires about 241 MB of local recognition models. Next, voice settings will open so you can confirm preparation. Once ready, click the microphone to record and stop to turn speech into text. You can edit it before sending.CancelEnable and set up"')
    expect(openVoiceSetup).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['voiceLauncher.enable'] })) })
    expect(openVoiceSetup).toHaveBeenCalledTimes(1)
    expect(openVoiceSetup.mock.calls[0]![0].aborted).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('disables a locked composer and shows retryable failures inside the setup dialog', async () => {
    const openVoiceSetup = vi.fn<VoiceInputLauncherProps['openVoiceSetup']>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('unavailable')
    const view = render(<VoiceInputLauncher locked openVoiceSetup={openVoiceSetup} t={t} />)
    expect(screen.getByRole('button', { name: en['voiceLauncher.trigger'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en['voiceLauncher.trigger'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<VoiceInputLauncher locked={false} openVoiceSetup={openVoiceSetup} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['voiceLauncher.trigger'] }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['voiceLauncher.enable'] })) })
    expect(screen.getByRole('alert').textContent).toBe(en['voiceLauncher.failed'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.retry })) })
    expect(screen.getByRole('alert').textContent).toBe(en['voiceLauncher.unavailable'])
  })

  it('cancels a pending activation when dismissed, locked, or unmounted', async () => {
    const signals: AbortSignal[] = []
    const openVoiceSetup: VoiceInputLauncherProps['openVoiceSetup'] = (signal) => {
      signals.push(signal)
      return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve('cancelled') }, { once: true }) })
    }
    const view = render(<VoiceInputLauncher locked={false} openVoiceSetup={openVoiceSetup} t={t} />)
    const start = (): void => {
      fireEvent.click(screen.getByRole('button', { name: en['voiceLauncher.trigger'] }))
      fireEvent.click(screen.getByRole('button', { name: en['voiceLauncher.enable'] }))
    }
    start()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.cancel })) })
    expect(signals[0]!.aborted).toBe(true)
    start()
    await act(async () => { view.rerender(<VoiceInputLauncher locked openVoiceSetup={openVoiceSetup} t={t} />) })
    expect(signals[1]!.aborted).toBe(true)
    view.rerender(<VoiceInputLauncher locked={false} openVoiceSetup={openVoiceSetup} t={t} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['voiceLauncher.enable'] })) })
    await act(async () => { view.unmount() })
    expect(signals[2]!.aborted).toBe(true)
  })
})
