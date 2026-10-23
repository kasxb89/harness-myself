/** Sidebar customer support access and a request-owned QR dialog. */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button, IconLoadingOutlineRegular, IconQueueOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CustomerSupportRead } from './customer-support-reader.ts'
import actionCss from './DesktopUpdateCheck.module.css'
import css from './CustomerSupport.module.css'

/** Dialog-owned support settings read; no settings persist across opens. */
export interface CustomerSupportInjected {
  readonly readCustomerSupport: (signal: AbortSignal) => Promise<CustomerSupportRead>
}

/** Sidebar geometry, localized labels, and the registered support read capability. */
export type CustomerSupportProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'settings'> & InjectFace<CustomerSupportInjected>

/** An image load belongs to one mounted settings read, including late browser events. */
function SupportQr({ url, t, retry }: { readonly url: string; readonly t: CustomerSupportProps['t']; readonly retry: () => void }) {
  const [image, setImage] = useState<'loading' | 'ready' | 'failed'>('loading')
  return <div className={css.qrContainer}>
    {image === 'loading' && <div className={css.imageLoading} role="status" aria-label={t('customerSupport.imageLoading')}>
      <IconLoadingOutlineRegular className={actionCss.spinner} size={20} />
    </div>}
    {image !== 'failed' && <img className={clsx(css.qr, image === 'loading' && css.pending)}
      referrerPolicy="no-referrer" alt={t('customerSupport.qrAlt')}
      onLoad={() => { setImage('ready') }} onError={() => { setImage('failed') }} src={url} />}
    {image === 'failed' && <div className={css.imageFailure}>
      <p className={css.message} role="alert">{t('customerSupport.imageFailed')}</p>
      <Button variant="outline" size="sm" onClick={retry}>{t('customerSupport.retry')}</Button>
    </div>}
  </div>
}

/**
 * Open the current support QR; closure aborts reads and removes previously shown settings.
 * @param props - Sidebar geometry, localized copy, and Host read capability.
 * @returns The sidebar control and a viewport-bounded support dialog.
 */
export function CustomerSupport({ wide, t, readCustomerSupport }: CustomerSupportProps) {
  const [open, setOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [reading, setReading] = useState<CustomerSupportRead | null>(null)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void readCustomerSupport(controller.signal).then((result) => {
      if (!controller.signal.aborted) setReading(result)
    })
    return () => { controller.abort() }
  }, [open, readCustomerSupport, revision])
  const close = (): void => { setOpen(false); setReading(null) }
  const refresh = (): void => { setReading(null); setRevision(value => value + 1) }
  const details = reading?.ok === true && reading.payload.enabled ? reading.payload : null
  const missing = reading?.ok === true && !reading.payload.enabled || reading?.ok === false && reading.reason === 'unsupported'
  const failure = reading?.ok === false && reading.reason !== 'unsupported' ? reading.reason : null
  const failures = {
    network: t('customerSupport.network'), timeout: t('customerSupport.timeout'), unavailable: t('customerSupport.unavailable'),
    invalid: t('customerSupport.invalid'), authorization: t('customerSupport.authorization'), 'account-changed': t('customerSupport.accountChanged'),
  }
  const title = details?.title.trim() ? details.title : t('customerSupport.title')
  const description = details?.description.trim() ? details.description : t('customerSupport.description')
  return <>
    <Tooltip label={t('customerSupport.title')} side="right" portal>
      <button type="button" className={clsx(actionCss.button, actionCss.sidebar, !wide && actionCss.rail)}
        aria-label={t('customerSupport.title')} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true) }}>
        <IconQueueOutlineRegular size={wide ? 16 : 20} />
        <span className={wide ? actionCss.label : actionCss.railLabel}>{t('customerSupport.title')}</span>
      </button>
    </Tooltip>
    <Modal open={open} title={title} closeLabel={t('close')} onClose={close}
      className={clsx(css.dialog)} contentClassName={clsx(css.scroll)}
      footer={<Button variant="outline" size="sm" disabled={reading === null} onClick={refresh}>
        {t(failure !== null ? 'customerSupport.retry' : 'customerSupport.refresh')}
      </Button>}>
      {reading === null && <div className={css.loading} role="status" aria-label={t('customerSupport.loading')}>
        <IconLoadingOutlineRegular className={actionCss.spinner} size={20} />
      </div>}
      {missing && <p className={css.message}>{t('customerSupport.unconfigured')}</p>}
      {failure !== null && <p className={css.message} role="alert">{failures[failure]}</p>}
      {details !== null && <div className={css.details}>
        <p className={css.message}>{description}</p>
        <SupportQr url={details.qrCodeUrl} t={t} retry={refresh} />
      </div>}
    </Modal>
  </>
}
