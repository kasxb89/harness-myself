/** Artifact entry into the same package-local lazy PDF reader chunk. @module */
import { lazy, Suspense, type ReactNode } from 'react'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import type { ArtifactPdfBodyProps } from './pdf.tsx'

const LoadedArtifactPdfBody = lazy(async () => ({ default: (await import('./pdf.tsx')).ArtifactPdfBody }))

/** @param props - Artifact URL and registered PDF presentation. @returns The lazy shared PDF reader. */
export function LazyArtifactPdfBody(props: ArtifactPdfBodyProps): ReactNode {
  const loading = <LoadingIndicator label={props.t('loading')} />
  return <Suspense fallback={loading}><LoadedArtifactPdfBody {...props} loading={loading} /></Suspense>
}
