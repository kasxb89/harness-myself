import { useEffect } from 'react'
import { Button, Input, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Draft, ForumProps } from './types.ts'
import css from './ForumPage.module.css'

/** @param props - Framework-bound forum state, commands, and dictionary. @returns Demand-tab community workspace. */
export function ForumPage(props: ForumProps) {
  const { t } = props,
    state = props.useForum(s => s)
  useEffect(() => props.activate(), [props.activate])
  const author = (name: string) => name || t('member')
  const editor = (reply: boolean, draft: Draft) => (
    <form
      className={css.editor}
      onSubmit={(e) => {
        e.preventDefault()
        props.publish(reply)
      }}
    >
      {!reply ? (
        <Input
          value={draft.title}
          onChange={(e) => {
            props.edit(false, 'title', e.target.value)
          }}
          aria-label={t('postTitle')}
          placeholder={t('postTitle')}
          maxLength={200}
          disabled={draft.pending || draft.uncertain}
        />
      ) : null}
      <textarea
        className={css.textarea}
        aria-label={t(reply ? 'replyPlaceholder' : 'postBody')}
        placeholder={t(reply ? 'replyPlaceholder' : 'postBody')}
        value={draft.body}
        onChange={(e) => {
          props.edit(reply, 'body', e.target.value)
        }}
        maxLength={reply ? 4000 : 20000}
        rows={reply ? 3 : 6}
        disabled={draft.pending || draft.uncertain}
      />
      <div className={css.actions}>
        {!reply ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              props.compose(false)
            }}
            disabled={draft.pending}
          >
            {t('cancel')}
          </Button>
        ) : null}
        <Button
          type="submit"
          disabled={!state.enabled || state.busy || !draft.body.trim() || (!reply && !draft.title.trim())}
        >
          {t(draft.uncertain ? 'retryPublication' : reply ? 'comment' : 'publish')}
        </Button>
      </div>
    </form>
  )
  return (
    <section className={css.page} aria-label={t('title')}>
      <header className={css.header}>
        <div>
          <h1>{t('title')}</h1>
          <p>{t('intro')}</p>
        </div>
        <div className={css.actions}>
          <Button variant="ghost" onClick={props.refresh} disabled={state.loading || state.busy}>
            {t('refresh')}
          </Button>
          {state.post === null ? (
            <Button
              onClick={() => {
                props.compose(true)
              }}
              disabled={!state.signedIn || !state.enabled}
            >
              {t('newPost')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => {
                props.open(null)
              }}
              disabled={state.busy}
            >
              {t('back')}
            </Button>
          )}
        </div>
      </header>
      {state.error ? (
        <p className={css.error} role="alert">
          {state.error}
        </p>
      ) : null}
      {!state.signedIn ? (
        <p className={css.empty}>{t('login')}</p>
      ) : (
        <>
          {!state.enabled && !state.loading ? <p className={css.notice}>{t('closed')}</p> : null}
          <div className={css.content} aria-busy={state.loading}>
            {state.loading ? (
              <div className={css.loading} role="status" aria-label={t('loading')}>
                <IconLoadingOutlineRegular className={css.spinner} size={20} />
              </div>
            ) : null}
            {state.post === null ? (
              <>
                {state.composing ? editor(false, state.draft) : null}
                {!state.posts.length && !state.loading ? <p className={css.empty}>{t('empty')}</p> : null}
                {state.posts.map(row => (
                  <article key={row.id} className={css.row}>
                    <div className={css.meta}>
                      <span className={css.avatar} aria-hidden="true">
                        {author(row.author.display_name).slice(0, 1)}
                      </span>
                      <span>{author(row.author.display_name)}</span>
                      <time dateTime={new Date(row.created_at * 1000).toISOString()}>
                        {new Date(row.created_at * 1000).toLocaleString()}
                      </time>
                    </div>
                    <button
                      className={css.postLink}
                      onClick={() => {
                        props.open(row.id)
                      }}
                    >
                      <h2>{row.title}</h2>
                      <p>{row.body}</p>
                    </button>
                    <div className={css.actions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-pressed={row.liked}
                        disabled={state.busy || !state.enabled}
                        onClick={() => {
                          props.like(row.id)
                        }}
                      >
                        {t('like', { count: row.like_count })}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          props.open(row.id)
                        }}
                      >
                        {t('comments', { count: row.comment_count })}
                      </Button>
                    </div>
                  </article>
                ))}
                {state.feedCursor ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      props.more(false)
                    }}
                    disabled={state.busy}
                  >
                    {t('more')}
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <article className={css.detail}>
                  <div className={css.meta}>
                    {author(state.post.author.display_name)} ·{' '}
                    <time dateTime={new Date(state.post.created_at * 1000).toISOString()}>
                      {new Date(state.post.created_at * 1000).toLocaleString()}
                    </time>
                  </div>
                  <h2>{state.post.title}</h2>
                  <p className={css.body}>{state.post.body}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={state.post.liked}
                    disabled={state.busy || !state.enabled}
                    onClick={() => {
                      if (state.post) props.like(state.post.id)
                    }}
                  >
                    {t('like', { count: state.post.like_count })}
                  </Button>
                </article>
                <h3 className={css.commentHeading}>{t('comments', { count: state.post.comment_count })}</h3>
                {editor(true, state.reply)}
                {!state.comments.length && !state.loading ? (
                  <p className={css.notice}>{t('noComments')}</p>
                ) : null}
                {state.comments.map(row => (
                  <article key={row.id} className={css.row}>
                    <div className={css.meta}>
                      <span>{author(row.author.display_name)}</span>
                      <time dateTime={new Date(row.created_at * 1000).toISOString()}>
                        {new Date(row.created_at * 1000).toLocaleString()}
                      </time>
                    </div>
                    <p className={css.body}>{row.body}</p>
                  </article>
                ))}
                {state.commentsCursor ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      props.more(true)
                    }}
                    disabled={state.busy}
                  >
                    {t('more')}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}
