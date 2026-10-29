import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, CircleUserRound, Compass,
  ExternalLink, EyeOff, Flag, Heart, Image as ImageIcon, KeyRound, LayoutDashboard,
  LoaderCircle, LogIn, LogOut, Menu, Pencil, Plus, Save, Search, Send, Settings,
  ShieldCheck, Upload, UserPlus, Users, X,
} from 'lucide-react'
import { api, mediaUrl, uploadImage } from './api.js'
import { localWorkLinkError, workLinkError } from './work-link.js'

// 关卡（讲次）配置：换成自己的课程时改这一块。
// hint 是卡片上的一句说明；cover 留空则用占位图标，也可填自己的封面路径。
export const LESSONS = {
  1: { short: '第一讲', name: '第一讲作品', hint: '这门课第一讲的主题说明', cover: null },
  2: { short: '第二讲', name: '第二讲作品', hint: '这门课第二讲的主题说明', cover: null },
  3: { short: '第三讲', name: '第三讲作品', hint: '这门课第三讲的主题说明', cover: null },
}

// 站点品牌信息：部署成自己的课程时改这两行即可。
const ORG_NAME = '示例机构'
const COURSE_TITLE = '示例课程：如何做出实用生活小工具？'

const STATUS = {
  published: ['已公开', 'status-success'],
  pending: ['审核中', 'status-pending'],
  rejected: ['未通过', 'status-danger'],
  draft: ['草稿', 'status-neutral'],
  hidden: ['已隐藏', 'status-neutral'],
}

const SUBMIT_DRAFT_KEY = 'adventure-guild-submit-draft'

function requestBody(value) {
  return { body: JSON.stringify(value) }
}

function dateText(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value))
}

function localDateTimeValue(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function safeNext(value) {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/mine'
}

function StatusBadge({ status }) {
  const [label, className] = STATUS[status] || [status || '未知', 'status-neutral']
  return <span className={`status-badge ${className}`}>{label}</span>
}

function currentOwnerView(work) {
  return work.pendingVersion ? { ...work, ...work.pendingVersion } : work
}

function Notice({ type = 'info', children }) {
  return <div className={`notice notice-${type}`} role={type === 'error' ? 'alert' : 'status'}>
    {type === 'success' ? <CheckCircle2 size={18} /> : type === 'error' ? <AlertTriangle size={18} /> : <ShieldCheck size={18} />}
    <span>{children}</span>
  </div>
}

function PageHeader({ back, navigate, kicker, title, detail, actions }) {
  return <div className="page-heading">
    {back && <Link to={back} navigate={navigate} className="back-link"><ArrowLeft size={17} />返回</Link>}
    {kicker && <span className="section-kicker">{kicker}</span>}
    <div className="page-heading-row">
      <div><h1>{title}</h1>{detail && <p>{detail}</p>}</div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  </div>
}

function useRoute() {
  const read = () => ({ pathname: window.location.pathname, search: window.location.search })
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onPop = () => setRoute(read())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const navigate = useCallback((to, { replace = false } = {}) => {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', to)
    setRoute(read())
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [])
  return { ...route, navigate }
}

function Link({ to, navigate, className, children, onClick, ...props }) {
  return <a href={to} className={className} onClick={(event) => {
    onClick?.(event)
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault()
      navigate(to)
    }
  }} {...props}>{children}</a>
}

function Shell({ navigate, me, mode, sessionError, retrySession, children }) {
  const [menu, setMenu] = useState(false)
  return <div className="app-shell">
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand" to="/" navigate={navigate} aria-label="冒险公会首页">
          <span className="brand-mark"><Compass size={22} /></span>
          <span><b>地球 Online</b></span>
        </Link>
        <nav className={menu ? 'nav-links is-open' : 'nav-links'} aria-label="主要导航">
          <Link to="/" navigate={navigate} onClick={() => setMenu(false)}>作品广场</Link>
          <Link to="/community" navigate={navigate} onClick={() => setMenu(false)}>公会联络站</Link>
          <Link to={me ? '/mine' : '/login'} navigate={navigate} onClick={() => setMenu(false)}>{me ? '我的展台' : '登录'}</Link>
          {me?.role === 'admin' && <Link to="/admin" navigate={navigate} onClick={() => setMenu(false)}>管理后台</Link>}
          <Link className="button button-gold button-small" to="/submit" navigate={navigate} onClick={() => setMenu(false)}>
            <Plus size={16} />发布作品
          </Link>
        </nav>
        <button className="icon-button menu-button" type="button" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="打开导航">
          {menu ? <X /> : <Menu />}
        </button>
      </div>
    </header>
    {mode === 'local-demo' && <div className="demo-banner"><ShieldCheck size={16} />本机演示模式：未启用真实 AI 审核，页面内容仅用于功能演示</div>}
    {sessionError && <div className="session-banner"><AlertTriangle size={16} />登录状态暂时无法确认，已保留当前页面状态。<button onClick={() => retrySession()}>重新连接</button></div>}
    <main>{children}</main>
    <footer className="site-footer">
      <div><b>{ORG_NAME}</b><span>{COURSE_TITLE}</span><span>课程配套作品站 · 学员作品由作者独立创作</span></div>
      <Link to="/community" navigate={navigate}>加入公会 <ChevronRight size={15} /></Link>
    </footer>
  </div>
}

function Cover({ work, large = false }) {
  const [failed, setFailed] = useState(false)
  const custom = work.coverId && !failed
  const source = custom ? mediaUrl(work.coverId) : LESSONS[work.lesson]?.cover
  return <div className={`work-cover${large ? ' work-cover-large' : ''}${custom ? ' work-cover-custom' : ''}`}>
    {source ? <img src={source} alt={`${work.title || LESSONS[work.lesson]?.name || '作品'}封面`} onError={() => {
      if (custom) setFailed(true)
    }} /> : <div className="cover-placeholder"><ImageIcon /><span>{LESSONS[work.lesson]?.name}</span></div>}
    <span className={`lesson-badge lesson-${work.lesson}`}>{LESSONS[work.lesson]?.short}</span>
    {!custom && <span className="default-cover-note">课程默认封面</span>}
  </div>
}

function WorkCard({ work, navigate }) {
  return <article className="work-card">
    <Link to={`/works/${work.id}`} navigate={navigate} className="card-cover-link"><Cover work={work} /></Link>
    <div className="work-card-body">
      <Link to={`/works/${work.id}`} navigate={navigate} className="work-title">{work.title || LESSONS[work.lesson]?.name || '未命名作品'}</Link>
      <p>{work.description || '这位勇士正在用作品讲述自己的冒险。'}</p>
      <div className="card-meta">
        <Link to={`/people/${work.userId}`} navigate={navigate} className="creator"><CircleUserRound size={17} />{work.nickname}</Link>
        <span aria-label={`${work.likes} 票`}><Heart size={16} fill={work.liked ? 'currentColor' : 'none'} />{work.likes || 0}</span>
      </div>
    </div>
  </article>
}

function StatePanel({ icon, title, detail, action }) {
  return <div className="state-panel">
    <div className="state-icon">{icon}</div>
    <h2>{title}</h2>
    {detail && <p>{detail}</p>}
    {action}
  </div>
}

function LoadingCards() {
  return <div className="work-grid" aria-label="正在加载作品">
    {[1, 2, 3, 4, 5, 6].map((item) => <div className="work-card skeleton-card" key={item}><div className="skeleton cover-skeleton" /><div className="work-card-body"><div className="skeleton line-wide" /><div className="skeleton line-short" /></div></div>)}
  </div>
}

function GalleryPage({ navigate }) {
  const params = new URLSearchParams(window.location.search)
  const initialLesson = params.get('lesson') || 'all'
  const [lesson, setLesson] = useState(['all', '1', '2', '3'].includes(initialLesson) ? initialLesson : 'all')
  const [query, setQuery] = useState(params.get('q') || '')
  const [searchInput, setSearchInput] = useState(params.get('q') || '')
  const [page, setPage] = useState(Math.max(1, Number(params.get('page')) || 1))
  const [state, setState] = useState({ loading: true, works: [], total: 0, pageSize: 12, error: '' })

  const load = useCallback(async () => {
    setState((old) => ({ ...old, loading: true, error: '' }))
    try {
      const search = new URLSearchParams()
      if (lesson !== 'all') search.set('lesson', lesson)
      if (query.trim()) search.set('q', query.trim())
      if (page > 1) search.set('page', String(page))
      const data = await api(`/works${search.size ? `?${search}` : ''}`)
      setState({ loading: false, works: data.works || [], total: data.total || 0, pageSize: data.pageSize || 12, error: '' })
      const url = `/${search.size ? `?${search}` : ''}`
      window.history.replaceState({}, '', url)
    } catch (error) {
      setState((old) => ({ ...old, loading: false, error: error.message }))
    }
  }, [lesson, query, page])

  useEffect(() => { load() }, [load])

  const visitLesson = (value) => {
    setLesson(value)
    setPage(1)
    setQuery('')
    setSearchInput('')
    document.getElementById('gallery-results')?.scrollIntoView({ block: 'start' })
  }

  return <>
    <section className="hero earth-hero" aria-labelledby="earth-title">
      <div className="hero-inner">
        <div className="course-identity"><span>{ORG_NAME}</span></div>
        <h1 id="earth-title">冒险<em>公会</em></h1>
        <p className="course-title">{COURSE_TITLE}</p>
        <div className="hero-actions">
          <Link className="button button-gold" to="/submit" navigate={navigate}><Plus size={18} />发布我的作品</Link>
          <a className="button button-ghost" href="#gallery">逛逛作品 <ChevronRight size={18} /></a>
        </div>
      </div>
    </section>

    <section className="gallery-section" id="gallery">
      <div className="quest-heading"><span>三次课程，三次创造</span><small>选择一讲，查看该讲的作品</small></div>
      <div className="quest-grid" aria-label="三讲作品入口">
        {Object.entries(LESSONS).map(([value, item]) => <button key={value} className={`quest-card quest-${value}${lesson === value ? ' is-selected' : ''}`} onClick={() => visitLesson(value)} aria-pressed={lesson === value} aria-label={`${item.short}：查看${item.name}作品`}>
          {item.cover ? <img src={item.cover} alt="" width="800" height="800" /> : <span className="quest-art" aria-hidden="true"><Compass size={40} /></span>}
          <span className="quest-copy"><small>{item.short}</small><strong>{item.name}</strong><span>{item.hint}</span><b>查看作品 <ChevronRight size={15} /></b></span>
        </button>)}
      </div>
      <div id="gallery-results" />
      <div className="section-heading">
        <div><h2>作品广场</h2></div>
        <span className="gallery-count"><b>{state.loading ? '—' : state.total}</b> 件{lesson === 'all' && !query ? '公开' : '匹配'}作品</span>
      </div>
      <div className="gallery-tools">
        <div className="filter-tabs" role="tablist" aria-label="按课程筛选">
          {[['all', '全部作品'], ['1', '第一讲'], ['2', '第二讲'], ['3', '第三讲']].map(([value, label]) => <button role="tab" aria-selected={lesson === value} className={lesson === value ? 'active' : ''} onClick={() => { setLesson(value); setPage(1) }} key={value}>{label}</button>)}
        </div>
        <form className="search-box" onSubmit={(event) => { event.preventDefault(); setQuery(searchInput); setPage(1) }}>
          <Search size={18} /><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="搜索作品或勇士昵称" aria-label="搜索作品" /><button type="submit">搜索</button>
        </form>
      </div>

      {state.loading ? <LoadingCards /> : state.error ? <StatePanel icon={<Compass />} title="作品暂时迷路了" detail={state.error} action={<button className="button button-primary" onClick={load}>重新加载</button>} /> : state.works.length === 0 ? <StatePanel icon={<Search />} title="还没有找到作品" detail={query ? '换个关键词，或者看看其他课程吧。' : '成为第一位在这里留下足迹的勇士。'} action={<Link className="button button-primary" to="/submit" navigate={navigate}>发布作品</Link>} /> : <><div className="work-grid">{state.works.map((work) => <WorkCard work={work} navigate={navigate} key={work.id} />)}</div>{state.total > state.pageSize && <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page} / {Math.ceil(state.total / state.pageSize)} 页</span><button disabled={page >= Math.ceil(state.total / state.pageSize)} onClick={() => setPage(page + 1)}>下一页</button></div>}</>}
    </section>
    <CommunityInvite navigate={navigate} />
  </>
}

function CommunityInvite({ navigate }) {
  const [settings, setSettings] = useState(null)
  useEffect(() => {
    let active = true
    api('/settings').then(data => { if (active) setSettings(data.settings) }).catch(() => {})
    return () => { active = false }
  }, [])
  if (!settings?.officialQrId) return null
  return <aside className="community-invite">
    <div><span className="eyebrow">冒险还在继续</span><h2>下一次创造，我们再见。</h2><p>关注「{settings.officialAccountName || '官方'}」公众号，获取后续课程与学习消息。</p><small>自愿关注，不影响浏览和发布作品。</small><Link to="/community" navigate={navigate}>查看公众号二维码 <ChevronRight size={16} /></Link></div>
    <figure><img src={mediaUrl(settings.officialQrId)} alt={`${settings.officialAccountName || '官方'}公众号二维码`} width="150" height="150" /><figcaption>微信扫码 · 关注公众号</figcaption></figure>
  </aside>
}

function WorkDetailPage({ id, navigate, me }) {
  const [state, setState] = useState({ loading: true, work: null, error: '' })
  const [busy, setBusy] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [report, setReport] = useState({ reason: 'link', detail: '' })
  const [feedback, setFeedback] = useState('')

  const load = useCallback(async () => {
    setState({ loading: true, work: null, error: '' })
    try {
      const data = await api(`/works/${encodeURIComponent(id)}`)
      setState({ loading: false, work: data.work, error: '' })
    } catch (error) {
      setState({ loading: false, work: null, error: error.message })
    }
  }, [id])
  useEffect(() => { load() }, [load])

  async function toggleLike() {
    if (!me) {
      navigate(`/login?next=${encodeURIComponent(`/works/${id}`)}`)
      return
    }
    setBusy(true)
    setFeedback('')
    try {
      const result = await api(`/works/${id}/like`, { method: 'POST', ...requestBody({ liked: !state.work.liked }) })
      setState((old) => ({ ...old, work: { ...old.work, ...result } }))
    } catch (error) {
      setFeedback(error.message)
    } finally { setBusy(false) }
  }

  async function sendReport(event) {
    event.preventDefault()
    setBusy(true)
    setFeedback('')
    try {
      await api(`/works/${id}/report`, { method: 'POST', ...requestBody(report) })
      setReportOpen(false)
      setFeedback('谢谢提醒，公会管理员会查看这条反馈。')
    } catch (error) { setFeedback(error.message) } finally { setBusy(false) }
  }

  if (state.loading) return <div className="page-container"><StatePanel icon={<LoaderCircle className="spin" />} title="正在打开作品" /></div>
  if (state.error || !state.work) return <div className="page-container"><StatePanel icon={<Compass />} title="没有找到这件作品" detail={state.error} action={<button className="button button-primary" onClick={load}>重新加载</button>} /></div>
  const work = state.work
  return <div className="page-container detail-page">
    <PageHeader back="/" navigate={navigate} kicker={`${LESSONS[work.lesson]?.short} · ${LESSONS[work.lesson]?.name}`} title={work.title || LESSONS[work.lesson]?.name} detail={`由 ${work.nickname} 发布 · ${dateText(work.createdAt)}`} />
    <div className="detail-layout">
      <div className="detail-main"><Cover work={work} large /></div>
      <aside className="detail-aside">
        <div className="detail-description"><span>勇士的话</span><p>{work.description || '这位勇士暂时没有留下作品介绍。'}</p></div>
        <a className="button button-primary button-wide" href={work.url} target="_blank" rel="noopener noreferrer">打开作品 <ExternalLink size={18} /></a>
        <p className="external-note">作品将在新标签页打开。请不要在陌生页面填写隐私信息。</p>
        <div className="detail-actions">
          <button type="button" className={work.liked ? 'vote-button is-liked' : 'vote-button'} onClick={toggleLike} disabled={busy}><Heart size={20} fill={work.liked ? 'currentColor' : 'none'} />{work.liked ? '已投一票' : '为作品投票'}<b>{work.likes || 0}</b></button>
          <Link to={`/people/${work.userId}`} navigate={navigate} className="text-button"><CircleUserRound size={18} />看看 TA 的展台</Link>
          <button type="button" className="text-button danger-text" onClick={() => setReportOpen(!reportOpen)}><Flag size={17} />反馈作品问题</button>
        </div>
        {feedback && <Notice type={feedback.startsWith('谢谢') ? 'success' : 'error'}>{feedback}</Notice>}
        {reportOpen && <form className="report-form" onSubmit={sendReport}>
          <label>问题类型<select value={report.reason} onChange={(e) => setReport({ ...report, reason: e.target.value })}><option value="link">链接无法访问或不安全</option><option value="content">内容不合适</option></select></label>
          <label>补充说明（选填）<textarea maxLength="200" rows="3" value={report.detail} onChange={(e) => setReport({ ...report, detail: e.target.value })} /></label>
          <button className="button button-secondary" disabled={busy}>提交反馈</button>
        </form>}
      </aside>
    </div>
  </div>
}

function ProfilePage({ id, navigate }) {
  const [state, setState] = useState({ loading: true, profile: null, works: [], error: '' })
  const load = useCallback(async () => {
    setState((old) => ({ ...old, loading: true, error: '' }))
    try {
      const data = await api(`/profiles/${encodeURIComponent(id)}`)
      setState({ loading: false, profile: data.profile, works: data.works || [], error: '' })
    } catch (error) { setState({ loading: false, profile: null, works: [], error: error.message }) }
  }, [id])
  useEffect(() => { load() }, [load])
  if (state.loading) return <div className="page-container"><StatePanel icon={<LoaderCircle className="spin" />} title="正在搭建展台" /></div>
  if (state.error) return <div className="page-container"><StatePanel icon={<CircleUserRound />} title="没有找到这位勇士" detail={state.error} action={<Link className="button button-primary" to="/" navigate={navigate}>返回广场</Link>} /></div>
  const byLesson = new Map(state.works.map((work) => [work.lesson, work]))
  return <div className="page-container">
    <PageHeader back="/" navigate={navigate} kicker="勇士个人展台" title={state.profile.nickname} detail="三次课程，三次真实创造。这里记录着这位勇士走过的路。" />
    <div className="profile-banner"><div className="profile-avatar"><CircleUserRound size={40} /></div><div><b>{state.profile.nickname}</b><span>冒险公会勇士</span></div><div className="profile-count"><b>{state.works.length}</b><span>/ 3 件作品</span></div></div>
    <div className="slot-grid">
      {[1, 2, 3].map((lesson) => {
        const work = byLesson.get(lesson)
        return work ? <WorkCard key={lesson} work={work} navigate={navigate} /> : <div className="empty-slot" key={lesson}><span>{LESSONS[lesson].short}</span><div><ImageIcon /><b>{LESSONS[lesson].name}</b><p>这次冒险的作品还没有公开</p></div></div>
      })}
    </div>
  </div>
}

function AuthPage({ navigate, me, refreshSession }) {
  const params = new URLSearchParams(window.location.search)
  const [tab, setTab] = useState(params.get('tab') === 'register' ? 'register' : params.get('tab') === 'recover' ? 'recover' : 'login')
  const [form, setForm] = useState({ username: '', password: '', nickname: '', phone: '', newPassword: '', remember: true })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState({ type: '', text: '' })
  const next = safeNext(params.get('next'))
  useEffect(() => { if (me) navigate(next, { replace: true }) }, [me, navigate, next])

  function update(key, value) { setForm((old) => ({ ...old, [key]: value })) }
  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setMessage({ type: '', text: '' })
    try {
      if (tab === 'login') {
        const result = await api('/auth/login', { method: 'POST', ...requestBody({ username: form.username, password: form.password, remember: form.remember }) })
        await refreshSession(result.user)
        navigate(next, { replace: true })
      } else if (tab === 'register') {
        const result = await api('/auth/register', { method: 'POST', ...requestBody({ username: form.username, password: form.password, nickname: form.nickname, phone: form.phone, remember: form.remember }) })
        await refreshSession(result.user)
        navigate(next, { replace: true })
      } else {
        await api('/auth/recover', { method: 'POST', ...requestBody({ username: form.username, phone: form.phone, newPassword: form.newPassword }) })
        setForm((old) => ({ ...old, password: '', phone: '', newPassword: '' }))
        setMessage({ type: 'success', text: '密码已经重设，请使用新密码登录。' })
        setTab('login')
      }
    } catch (error) { setMessage({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }

  return <div className="auth-page">
    <section className="auth-intro"><div><span className="eyebrow"><span />地球 ONLINE · 冒险公会</span><h1>回到公会，<br />继续你的创造。</h1><p>登录后可以发布作品、投票，也能随时管理自己的三讲展台。</p></div></section>
    <section className="auth-panel">
      <div className="auth-card">
        <div className="auth-tabs">
          <button className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}><LogIn size={17} />登录</button>
          <button className={tab === 'register' ? 'active' : ''} onClick={() => setTab('register')}><UserPlus size={17} />注册</button>
          <button className={tab === 'recover' ? 'active' : ''} onClick={() => setTab('recover')}><KeyRound size={17} />找回</button>
        </div>
        <div className="auth-title"><h2>{tab === 'login' ? '欢迎回来' : tab === 'register' ? '加入冒险公会' : '重设登录密码'}</h2><p>{tab === 'recover' ? '填写注册时的用户名和手机号。首版不发送短信验证码。' : '作品会使用你的昵称公开展示，用户名只用于登录。'}</p></div>
        {message.text && <Notice type={message.type}>{message.text}</Notice>}
        {next.startsWith('/submit') && <Notice>你的作品文字草稿还在本浏览器中；登录后会回到发布页。图片需重新选择。</Notice>}
        <form className="form-stack" onSubmit={submit}>
          <label>用户名<input required autoComplete="username" value={form.username} onChange={(e) => update('username', e.target.value)} placeholder="用于登录，不公开" /></label>
          {tab === 'register' && <label>公开昵称<input required maxLength="20" autoComplete="nickname" value={form.nickname} onChange={(e) => update('nickname', e.target.value)} placeholder="作品旁显示的名字" /></label>}
          {tab === 'login' && <label>密码<input required type="password" autoComplete="current-password" value={form.password} onChange={(e) => update('password', e.target.value)} /></label>}
          {tab !== 'login' && <label>注册手机号<input required inputMode="tel" autoComplete="tel" value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="只用于找回，不会公开" /></label>}
          {tab === 'register' && <label>设置密码<input required minLength="8" type="password" autoComplete="new-password" value={form.password} onChange={(e) => update('password', e.target.value)} placeholder="至少 8 位" /></label>}
          {tab === 'recover' && <label>新密码<input required minLength="8" type="password" autoComplete="new-password" value={form.newPassword} onChange={(e) => update('newPassword', e.target.value)} placeholder="至少 8 位" /></label>}
          {tab !== 'recover' && <label className="check-row"><input type="checkbox" checked={form.remember} onChange={(e) => update('remember', e.target.checked)} /><span>在这台设备上保持登录</span></label>}
          {tab === 'recover' && <Notice type="error">知道用户名和注册手机号的人可能重设该账号密码。请只在自己的设备上操作。</Notice>}
          <button className="button button-primary button-wide" disabled={busy}>{busy && <LoaderCircle className="spin" size={17} />}{tab === 'login' ? '登录并继续' : tab === 'register' ? '注册并进入公会' : '重设密码'}</button>
        </form>
      </div>
    </section>
  </div>
}

function readSubmitDraft() {
  try { return JSON.parse(sessionStorage.getItem(SUBMIT_DRAFT_KEY)) || {} } catch { return {} }
}

function WorkLinkField({ id, value, onChange, forceError = false }) {
  const [checked, setChecked] = useState(false)
  const error = (checked || forceError) ? workLinkError(value) : localWorkLinkError(value)
  return <div className="work-link-field">
    <label htmlFor={id}>作品链接 <span className="required">必填</span></label>
    <input id={id} required type="url" inputMode="url" autoComplete="url" spellCheck={false} value={value} onChange={e => onChange(e.target.value)} onPaste={() => setChecked(true)} onBlur={() => setChecked(true)} placeholder="粘贴 WorkBuddy「分享给好友」生成的链接" aria-invalid={!!error} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} />
    <p className="work-link-hint" id={`${id}-hint`}>请使用 <b>WorkBuddy 的作品分享链接</b>。不要粘贴 <code>localhost</code>、<code>127.0.0.1</code> 或电脑里的文件地址，这些只有你自己能打开。</p>
    {error && <p className="work-link-error" id={`${id}-error`} role="alert"><AlertTriangle size={17} /><span>{error}</span></p>}
    <details className="share-link-help"><summary>不知道怎么获取分享链接？</summary><ol><li>在 WorkBuddy 中打开你的作品页面。</li><li>点击<b>「分享给好友」</b>，等待它生成分享链接。</li><li>点击<b>「复制链接」</b>，再粘贴到上面的输入框。</li></ol><p>不要直接复制浏览器地址栏里的本地预览地址。分享链接通常以 <code>https://workbuddy.link/</code> 开头；发布前可以先在无痕窗口打开试试。</p></details>
  </div>
}

function SubmitPage({ navigate, me, moderationReady, mode }) {
  const params = new URLSearchParams(window.location.search)
  const draft = useMemo(readSubmitDraft, [])
  const lessonParam = Number(params.get('lesson'))
  const draftLesson = Number(draft.lesson)
  const initialLesson = [1, 2, 3].includes(lessonParam) ? lessonParam : [1, 2, 3].includes(draftLesson) ? draftLesson : 1
  const [form, setForm] = useState({
    lesson: initialLesson,
    title: typeof draft.title === 'string' ? draft.title : LESSONS[initialLesson].name,
    description: typeof draft.description === 'string' ? draft.description : '',
    url: typeof draft.url === 'string' ? draft.url : '',
    consent: false,
  })
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState({ type: '', text: '' })

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  function setField(key, value) {
    setForm((old) => {
      const next = { ...old, [key]: value }
      if (key === 'lesson' && old.title === LESSONS[old.lesson].name) next.title = LESSONS[value].name
      return next
    })
  }
  function rememberDraft() {
    sessionStorage.setItem(SUBMIT_DRAFT_KEY, JSON.stringify({ lesson: form.lesson, title: form.title, description: form.description, url: form.url }))
  }
  function chooseFile(event) {
    const next = event.target.files?.[0] || null
    if (next && next.size > 2 * 1024 * 1024) {
      setMessage({ type: 'error', text: '图片不能超过 2MB，请压缩后再选。' })
      event.target.value = ''
      return
    }
    if (preview) URL.revokeObjectURL(preview)
    setFile(next)
    setPreview(next ? URL.createObjectURL(next) : '')
  }
  async function save(publish) {
    if (!form.url || !form.title.trim()) { setMessage({ type: 'error', text: '请填写作品链接和标题。' }); return }
    const linkError = workLinkError(form.url)
    if (linkError) { setMessage({ type: 'error', text: linkError }); document.getElementById('submit-work-url')?.focus(); return }
    if (publish && !form.consent) { setMessage({ type: 'error', text: '发布前请勾选公开展示同意。' }); return }
    if (!me) {
      rememberDraft()
      navigate(`/login?next=${encodeURIComponent(`/submit?lesson=${form.lesson}`)}`)
      return
    }
    setBusy(true)
    setMessage({ type: '', text: '' })
    try {
      let coverId
      if (file) ({ id: coverId } = await uploadImage(file))
      const data = await api('/works', { method: 'POST', ...requestBody({ lesson: form.lesson, title: form.title.trim(), description: form.description.trim(), url: form.url.trim(), coverId, publish, consent: publish ? form.consent : true }) })
      sessionStorage.removeItem(SUBMIT_DRAFT_KEY)
      setMessage({ type: 'success', text: data.message || (publish ? '作品已提交。' : '草稿已保存。') })
      setTimeout(() => navigate('/mine'), 700)
    } catch (error) {
      const hint = error.status === 409 ? '这一讲已经有作品了，请到“我的展台”编辑原作品。' : error.message
      setMessage({ type: 'error', text: hint })
    } finally { setBusy(false) }
  }
  return <div className="page-container form-page">
    <PageHeader back="/" navigate={navigate} kicker="发布作品" title="把你的冒险成果放上展台" detail="每讲只能登记一件作品。链接是必填项，封面和一句话介绍可以稍后补充。" />
    <div className="form-layout">
      <section className="form-card">
        {!me && <Notice>可以先填写内容；继续发布时会请你登录。文字草稿只暂存在本标签页，不保存手机号或密码。</Notice>}
        {mode === 'local-demo' && <Notice>当前为本机演示，未启用真实 AI 审核。演示通过不代表线上审核结论。</Notice>}
        {mode !== 'local-demo' && !moderationReady && <Notice type="error">自动审核尚未配置。公开提交会被保存为“审核中”，暂不会出现在广场。</Notice>}
        {message.text && <Notice type={message.type}>{message.text}</Notice>}
        <div className="form-stack">
          <fieldset><legend>选择课程</legend><div className="lesson-options">{[1, 2, 3].map((lesson) => <button type="button" className={form.lesson === lesson ? 'active' : ''} key={lesson} onClick={() => setField('lesson', lesson)}><b>{LESSONS[lesson].short}</b><span>{LESSONS[lesson].name}</span></button>)}</div></fieldset>
          <WorkLinkField id="submit-work-url" value={form.url} onChange={value => setField('url', value)} forceError={message.type === 'error'} />
          <label>作品标题 <span className="required">必填</span><input required maxLength="40" value={form.title} onChange={(e) => setField('title', e.target.value)} /></label>
          <label>一句话介绍 <span className="optional">选填</span><textarea rows="3" maxLength="60" value={form.description} onChange={(e) => setField('description', e.target.value)} placeholder="它解决了什么问题？你最满意哪里？" /><small className="count">{form.description.length} / 60</small></label>
          <label>作品截图 <span className="optional">选填</span><span className="file-picker"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseFile} /><Upload size={20} /><b>{file ? file.name : '选择 PNG、JPEG 或 WebP'}</b><small>不超过 2MB；不上传则使用课程默认封面</small></span></label>
          {preview && <div className="image-preview"><img src={preview} alt="待上传封面预览" /><button type="button" onClick={() => { URL.revokeObjectURL(preview); setPreview(''); setFile(null) }}><X size={16} />移除</button></div>}
          <label className="consent-row"><input type="checkbox" checked={form.consent} onChange={(e) => setField('consent', e.target.checked)} /><span><b>我同意公开展示这件作品</b><small>作品标题、介绍、截图、链接和我的昵称会在公会公开展示。请确认其中没有真实姓名、学校、住址、电话等隐私。</small></span></label>
          <div className="form-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => save(false)}><Save size={17} />保存草稿</button><button type="button" className="button button-primary" disabled={busy} onClick={() => save(true)}>{busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}提交发布</button></div>
        </div>
      </section>
      <aside className="form-guide"><h3>发布前检查</h3><ol><li><b>链接能打开</b><span>最好先在无痕窗口试一次</span></li><li><b>不含个人隐私</b><span>不要出现真名、学校、班级和联系方式</span></li><li><b>截图看得清</b><span>推荐横向 16:10，主体放在中间</span></li></ol></aside>
    </div>
  </div>
}

function MinePage({ navigate, me, refreshSession }) {
  const [state, setState] = useState({ loading: true, works: [], error: '' })
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState({ type: '', text: '' })
  const [nickname, setNickname] = useState(me?.nickname || '')
  const returnFocusRef = useRef(null)
  useEffect(() => { setNickname(me?.nickname || '') }, [me])
  useEffect(() => {
    if (!editing) {
      returnFocusRef.current?.focus()
      returnFocusRef.current = null
      return undefined
    }
    const closeOnEscape = (event) => { if (event.key === 'Escape') setEditing(null) }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [editing])
  const load = useCallback(async () => {
    if (!me) return
    setState((old) => ({ ...old, loading: true, error: '' }))
    try {
      const data = await api('/mine')
      setState({ loading: false, works: data.works || [], error: '' })
    } catch (error) { setState({ loading: false, works: [], error: error.message }) }
  }, [me])
  useEffect(() => { load() }, [load])

  async function logout() {
    await api('/auth/logout', { method: 'POST', ...requestBody({}) })
    await refreshSession(null, false)
    navigate('/')
  }
  function beginEdit(work) {
    returnFocusRef.current = document.activeElement
    const source = work.pendingVersion || work
    setEditing({ id: work.id, title: source.title || '', description: source.description || '', url: source.url || '', coverId: source.coverId || '', file: null, consent: false })
    setMessage({ type: '', text: '' })
  }
  async function updateWork(event) {
    event.preventDefault()
    const linkError = workLinkError(editing.url)
    if (linkError) { setMessage({ type: 'error', text: linkError }); document.getElementById('edit-work-url')?.focus(); return }
    if (!editing.consent) { setMessage({ type: 'error', text: '重新公开前，请勾选展示同意。' }); return }
    setBusy(true)
    try {
      let coverId = editing.coverId || undefined
      if (editing.file) ({ id: coverId } = await uploadImage(editing.file))
      const data = await api(`/works/${editing.id}`, { method: 'PUT', ...requestBody({ title: editing.title, description: editing.description, url: editing.url, coverId, publish: true, consent: true }) })
      setMessage({ type: 'success', text: data.message || '修改已提交。公开版本会在新版本通过审核前继续展示。' })
      setEditing(null)
      await load()
    } catch (error) { setMessage({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }
  async function hideWork(id) {
    if (!window.confirm('确定隐藏这件作品吗？隐藏后会立即从作品广场消失。')) return
    setBusy(true)
    try {
      await api(`/works/${id}/hide`, { method: 'POST', ...requestBody({}) })
      setMessage({ type: 'success', text: '作品已隐藏。' })
      await load()
    } catch (error) { setMessage({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }
  async function updateNickname(event) {
    event.preventDefault()
    setBusy(true)
    try {
      const data = await api('/profile', { method: 'PATCH', ...requestBody({ nickname }) })
      setMessage({ type: 'success', text: data.message || '昵称修改已提交审核。' })
      await refreshSession()
    } catch (error) { setMessage({ type: 'error', text: error.message }) } finally { setBusy(false) }
  }
  if (!me) return <div className="page-container"><StatePanel icon={<LogIn />} title="登录后查看我的展台" detail="你的三讲作品、草稿和审核状态都会集中在这里。" action={<Link className="button button-primary" to="/login?next=%2Fmine" navigate={navigate}>前往登录</Link>} /></div>
  return <div className="page-container mine-page">
    <PageHeader kicker="MY SHOWCASE" title="我的展台" detail={`${me.nickname} · ${me.phoneMasked || '未显示找回手机号'}`} actions={<button className="button button-secondary" onClick={logout}><LogOut size={17} />退出登录</button>} />
    {message.text && <Notice type={message.type}>{message.text}</Notice>}
    <section className="profile-settings compact-card"><form onSubmit={updateNickname}><label>公开昵称<input maxLength="20" required value={nickname} onChange={(e) => setNickname(e.target.value)} /></label><button className="button button-secondary" disabled={busy}>更新昵称</button></form><p>昵称修改同样需要内容审核；未通过时不会覆盖当前公开昵称。</p></section>
    {state.loading ? <LoadingCards /> : state.error ? <StatePanel icon={<Compass />} title="展台加载失败" detail={state.error} action={<button className="button button-primary" onClick={load}>重新加载</button>} /> : <div className="mine-slots">{[1, 2, 3].map((lesson) => {
      const work = state.works.find((item) => item.lesson === lesson)
      return <section className="mine-slot" key={lesson}>
        <div className="mine-slot-title"><div><span>{LESSONS[lesson].short}</span><h2>{LESSONS[lesson].name}</h2></div>{work && <StatusBadge status={work.status} />}</div>
        {!work ? <div className="empty-slot"><ImageIcon /><p>这一讲还没有作品</p><Link className="button button-primary" to={`/submit?lesson=${lesson}`} navigate={navigate}>去发布</Link></div> : <>
          <Cover work={currentOwnerView(work)} />
          <div className="mine-work-info"><h3>{(work.pendingVersion || work).title || LESSONS[lesson].name}</h3><p>{(work.pendingVersion || work).description || '暂无介绍'}</p>{work.moderationReason && <Notice type="error">审核说明：{work.moderationReason}</Notice>}{work.pendingVersion && work.pendingVersion.status !== 'draft' && work.status === 'published' && <Notice>新版本正在审核，广场仍展示上一次通过的版本。</Notice>}<div className="mine-work-actions"><button className="button button-secondary" onClick={() => beginEdit(work)}><Pencil size={16} />编辑</button>{work.status !== 'hidden' && <button className="button button-danger" disabled={busy} onClick={() => hideWork(work.id)}><EyeOff size={16} />隐藏</button>}</div></div>
        </>}
      </section>
    })}</div>}
    {editing && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditing(null) }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="edit-title">
        <button autoFocus aria-label="关闭编辑窗口" className="modal-close icon-button" onClick={() => setEditing(null)}><X /></button>
        <h2 id="edit-title">编辑作品</h2><p>提交修改后将重新审核。审核通过前，旧的公开版本会继续展示。</p>
        <form className="form-stack" onSubmit={updateWork}>
          <WorkLinkField id="edit-work-url" value={editing.url} onChange={url => setEditing({ ...editing, url })} forceError={message.type === 'error'} />
          <label>标题<input required maxLength="40" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label>
          <label>一句话介绍<textarea maxLength="60" rows="3" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label>
          <label>替换截图<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setEditing({ ...editing, file: e.target.files?.[0] || null })} /></label>
          <label className="consent-row"><input type="checkbox" checked={editing.consent} onChange={(e) => setEditing({ ...editing, consent: e.target.checked })} /><span><b>我同意公开展示修改后的内容</b><small>确认作品中不含个人隐私。</small></span></label>
          <button className="button button-primary button-wide" disabled={busy}>{busy && <LoaderCircle size={17} className="spin" />}保存并提交审核</button>
        </form>
      </section>
    </div>}
  </div>
}

function CommunityPage({ navigate }) {
  const [state, setState] = useState({ loading: true, settings: null, error: '' })
  const load = useCallback(async () => {
    setState({ loading: true, settings: null, error: '' })
    try { const data = await api('/settings'); setState({ loading: false, settings: data.settings, error: '' }) }
    catch (error) { setState({ loading: false, settings: null, error: error.message }) }
  }, [])
  useEffect(() => { load() }, [load])
  return <div className="page-container community-page">
    <PageHeader back="/" navigate={navigate} kicker="GUILD COMMUNITY" title="公会联络站" detail="课程结束不是冒险的终点。关注公众号，继续获取后续课程与学习消息。" />
    {state.loading ? <StatePanel icon={<LoaderCircle className="spin" />} title="正在连接公会" /> : state.error ? <StatePanel icon={<Users />} title="联络站暂时不可用" detail={state.error} action={<button className="button button-primary" onClick={load}>重新加载</button>} /> : <>
      {state.settings?.announcement && <Notice>{state.settings.announcement}</Notice>}
      <div className={`community-grid${state.settings?.groupEnabled && state.settings?.groupQrId ? '' : ' community-single'}`}>
        <QrCard icon={<Compass />} title="公众号" name={state.settings?.officialAccountName} qrId={state.settings?.officialQrId} detail="扫码关注，获取后续课程和公会活动。关注完全自愿，不影响浏览与发布作品。" />
        {state.settings?.groupEnabled && state.settings?.groupQrId && <QrCard icon={<Users />} title="课程交流群" name={state.settings.groupName} qrId={state.settings.groupQrId} detail={state.settings.groupExpiresAt ? `二维码有效期至 ${dateText(state.settings.groupExpiresAt)}` : '扫码加入课程交流群，和其他勇士分享作品。'} />}
      </div>
    </>}
  </div>
}

function QrCard({ icon, title, name, qrId, detail, unavailable }) {
  return <section className="qr-card"><div className="qr-card-heading"><span>{icon}</span><div><h2>{title}</h2><p>{name || '暂未配置名称'}</p></div></div>{qrId && !unavailable ? <img className="qr-image" src={mediaUrl(qrId)} alt={`${title}二维码`} /> : <div className="qr-empty"><ImageIcon /><b>二维码暂未开放</b><span>管理员更新后会在这里出现</span></div>}<p className="qr-detail">{unavailable ? '当前二维码已停用或过期，请稍后再来查看。' : detail}</p><small>请使用微信扫码，确认名称无误后再继续。</small></section>
}

function AdminPage({ navigate, me }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' })
  const [settings, setSettings] = useState(null)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState({ type: '', text: '' })
  const load = useCallback(async () => {
    if (me?.role !== 'admin') return
    setState((old) => ({ ...old, loading: true, error: '' }))
    try {
      const [overview, publicSettings] = await Promise.all([api('/admin/overview'), api('/settings')])
      setState({ loading: false, data: overview, error: '' })
      setSettings(overview.settings || publicSettings.settings)
    } catch (error) { setState({ loading: false, data: null, error: error.message }) }
  }, [me])
  useEffect(() => { load() }, [load])

  async function review(id, action) {
    setBusy(`${action}-${id}`)
    setMessage({ type: '', text: '' })
    try {
      await api(`/admin/works/${id}/review`, { method: 'POST', ...requestBody({ action }) })
      setMessage({ type: 'success', text: action === 'approve' ? '作品已人工批准公开。' : '作品已隐藏。' })
      await load()
    } catch (error) { setMessage({ type: 'error', text: error.message }) } finally { setBusy('') }
  }
  async function uploadQr(kind, file) {
    if (!file) return
    setBusy(`upload-${kind}`)
    setMessage({ type: '', text: '' })
    try {
      const { id } = await uploadImage(file)
      setSettings((old) => ({ ...old, [kind]: id }))
      setMessage({ type: 'success', text: '二维码图片已上传；请点击“保存联络站设置”让它生效。' })
    } catch (error) { setMessage({ type: 'error', text: error.message }) } finally { setBusy('') }
  }
  async function saveSettings(event) {
    event.preventDefault()
    setBusy('settings')
    try {
      const payload = { ...settings, groupExpiresAt: settings.groupExpiresAt ? new Date(settings.groupExpiresAt).toISOString() : null }
      const data = await api('/admin/settings', { method: 'PUT', ...requestBody(payload) })
      setSettings(data.settings)
      setMessage({ type: 'success', text: '联络站设置已保存。' })
    } catch (error) { setMessage({ type: 'error', text: error.message }) } finally { setBusy('') }
  }
  if (!me) return <div className="page-container"><StatePanel icon={<LogIn />} title="请先登录管理员账号" action={<Link className="button button-primary" to="/login?next=%2Fadmin" navigate={navigate}>前往登录</Link>} /></div>
  if (me.role !== 'admin') return <div className="page-container"><StatePanel icon={<ShieldCheck />} title="这里仅供公会管理员使用" detail="当前账号没有管理权限。" action={<Link className="button button-primary" to="/" navigate={navigate}>返回广场</Link>} /></div>
  if (state.loading) return <div className="page-container"><StatePanel icon={<LoaderCircle className="spin" />} title="正在加载管理台" /></div>
  if (state.error) return <div className="page-container"><StatePanel icon={<AlertTriangle />} title="管理台加载失败" detail={state.error} action={<button className="button button-primary" onClick={load}>重新加载</button>} /></div>
  const data = state.data
  return <div className="page-container admin-page">
    <PageHeader kicker="GUILD ADMIN" title="公会管理台" detail={`运行模式：${data.mode === 'local-demo' ? '本机演示' : '正式环境'} · 自动审核：${data.moderationReady ? '已连接' : '未配置'}`} />
    {data.mode === 'local-demo' && <Notice>本机演示没有真实 AI 审核，演示数据与线上环境隔离。</Notice>}
    {!data.moderationReady && data.mode !== 'local-demo' && <Notice type="error">自动审核未配置，新投稿会停留在审核中。管理员批准是明确的人工例外操作。</Notice>}
    {message.text && <Notice type={message.type}>{message.text}</Notice>}
    <div className="stat-grid">
      {[['注册勇士', data.stats.users, <Users />], ['全部作品', data.stats.works, <ImageIcon />], ['待审核', data.stats.pending, <ShieldCheck />], ['待查反馈', data.stats.reports, <Flag />]].map(([label, value, icon]) => <div className="stat-card" key={label}><span>{icon}</span><div><b>{value ?? 0}</b><small>{label}</small></div></div>)}
    </div>
    <div className="admin-grid">
      <section className="admin-section"><div className="admin-section-title"><div><LayoutDashboard /><h2>作品审核</h2></div><span>{data.works?.length || 0} 条近期记录</span></div>{!data.works?.length ? <p className="table-empty">没有需要展示的作品记录。</p> : <div className="admin-list">{data.works.map((work) => <article className="admin-work" key={work.id}><div className="admin-thumb"><Cover work={currentOwnerView(work)} /></div><div className="admin-work-main"><div><StatusBadge status={work.pendingVersion?.status === 'review' ? 'pending' : work.pendingVersion?.status === 'reject' ? 'rejected' : work.status} /><span>{LESSONS[work.lesson]?.short}</span></div><h3>{currentOwnerView(work).title || '未命名作品'}</h3><p>{work.nickname} · {currentOwnerView(work).url}</p>{work.moderationReason && <small className="reason">审核说明：{work.moderationReason}</small>}</div><div className="admin-work-actions">{((work.pendingVersion && work.pendingVersion.status !== 'draft') || (work.status !== 'published' && work.status !== 'draft')) && <button className="button button-success" disabled={!!busy} onClick={() => review(work.id, 'approve')}>{busy === `approve-${work.id}` && <LoaderCircle className="spin" size={16} />}批准</button>}{work.status !== 'hidden' && <button className="button button-danger" disabled={!!busy} onClick={() => review(work.id, 'hide')}>隐藏</button>}</div></article>)}</div>}</section>
      <section className="admin-section"><div className="admin-section-title"><div><Flag /><h2>作品反馈</h2></div></div>{!data.reports?.length ? <p className="table-empty">暂无待查反馈。</p> : <div className="report-list">{data.reports.map((report) => <article key={report.id}><b>{report.reason === 'link' ? '链接问题' : '内容问题'}</b><span>作品 #{report.workId}</span><p>{report.detail || '未填写补充说明'}</p><small>{dateText(report.createdAt)}</small></article>)}</div>}</section>
    </div>
    {settings && <section className="admin-section settings-section"><div className="admin-section-title"><div><Settings /><h2>联络站设置</h2></div><span>二维码由管理员手动更新</span></div><form className="settings-form" onSubmit={saveSettings}>
      <div className="settings-column"><h3>官方公众号</h3><label>名称<input value={settings.officialAccountName || ''} onChange={(e) => setSettings({ ...settings, officialAccountName: e.target.value })} /></label><label>二维码图片<span className="file-picker mini"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => uploadQr('officialQrId', e.target.files?.[0])} /><Upload size={18} /><b>{settings.officialQrId ? '替换二维码' : '上传二维码'}</b></span></label>{settings.officialQrId && <img className="settings-qr" src={mediaUrl(settings.officialQrId)} alt="公众号二维码预览" />}</div>
      <div className="settings-column"><h3>课程交流群</h3><label>群名称<input value={settings.groupName || ''} onChange={(e) => setSettings({ ...settings, groupName: e.target.value })} /></label><label>二维码图片<span className="file-picker mini"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => uploadQr('groupQrId', e.target.files?.[0])} /><Upload size={18} /><b>{settings.groupQrId ? '替换二维码' : '上传二维码'}</b></span></label><label>有效期<input type="datetime-local" value={localDateTimeValue(settings.groupExpiresAt)} onChange={(e) => setSettings({ ...settings, groupExpiresAt: e.target.value })} /></label><label className="check-row"><input type="checkbox" checked={!!settings.groupEnabled} onChange={(e) => setSettings({ ...settings, groupEnabled: e.target.checked })} /><span>启用群二维码</span></label></div>
      <label className="settings-announcement">联络站公告<textarea rows="3" maxLength="300" value={settings.announcement || ''} onChange={(e) => setSettings({ ...settings, announcement: e.target.value })} /></label><button className="button button-primary" disabled={!!busy}>{busy === 'settings' && <LoaderCircle className="spin" size={17} />}保存联络站设置</button>
    </form></section>}
  </div>
}

function NotFound({ navigate }) {
  return <div className="page-container"><StatePanel icon={<Compass />} title="这里还没有地图" detail="你访问的页面不存在，回作品广场继续冒险吧。" action={<Link className="button button-primary" to="/" navigate={navigate}>返回作品广场</Link>} /></div>
}

export default function App() {
  const route = useRoute()
  const [session, setSession] = useState({ loading: true, me: null, mode: '', moderationReady: false, error: '' })
  const refreshSession = useCallback(async (fallbackUser, preserveOnFailure = true) => {
    setSession((old) => ({ ...old, loading: true, error: '' }))
    try {
      const data = await api('/me')
      setSession({ loading: false, me: data.user, mode: data.mode, moderationReady: data.moderationReady, error: '' })
    } catch (error) {
      setSession((old) => ({ ...old, me: preserveOnFailure ? (old.me || fallbackUser || null) : null, loading: false, error: error.message || '无法连接服务器' }))
    }
  }, [])
  useEffect(() => { refreshSession() }, [refreshSession])

  let page
  const sessionDependent = ['/login', '/mine', '/admin'].includes(route.pathname) || route.pathname === '/submit' || /^\/works\//.test(route.pathname)
  if (session.loading && sessionDependent && !session.me) page = <div className="page-container"><StatePanel icon={<LoaderCircle className="spin" />} title="正在确认登录状态" /></div>
  else if (route.pathname === '/') page = <GalleryPage navigate={route.navigate} />
  else if (route.pathname.match(/^\/works\/[^/]+$/)) page = <WorkDetailPage id={route.pathname.split('/')[2]} navigate={route.navigate} me={session.me} />
  else if (route.pathname.match(/^\/people\/[^/]+$/)) page = <ProfilePage id={route.pathname.split('/')[2]} navigate={route.navigate} />
  else if (route.pathname === '/login') page = <AuthPage navigate={route.navigate} me={session.me} refreshSession={refreshSession} />
  else if (route.pathname === '/submit') page = <SubmitPage navigate={route.navigate} me={session.me} moderationReady={session.moderationReady} mode={session.mode} />
  else if (route.pathname === '/mine') page = <MinePage navigate={route.navigate} me={session.me} refreshSession={refreshSession} />
  else if (route.pathname === '/community') page = <CommunityPage navigate={route.navigate} />
  else if (route.pathname === '/admin') page = <AdminPage navigate={route.navigate} me={session.me} />
  else page = <NotFound navigate={route.navigate} />
  return <Shell navigate={route.navigate} me={session.me} mode={session.mode} sessionError={session.error} retrySession={refreshSession}>{page}</Shell>
}
