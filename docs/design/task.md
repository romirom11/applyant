Ось підсумковий опис проєкту.
# Job Search Harness
Локальна агентна система для повного циклу пошуку роботи: від пошуку вакансій до підготовки та заповнення заявки. Основний інтерфейс на першому етапі - **CLI**. Архітектура одразу відокремлює core від UI, щоб пізніше без переписування зробити macOS desktop app.
## 1. Основна ідея
Система постійно знає:
- хто кандидат;
- який у нього досвід;
- які проєкти він робив;
- що саме він робив у кожному проєкті;
- які технології реально використовував;
- які твердження можна підтвердити джерелами;
- яку роботу він шукає;
- куди вже подавався;
- які вакансії вже бачив або відхилив.
Далі агенти самостійно:
```text
search
→ verify
→ deduplicate
→ analyze
→ match
→ research
→ prepare application
→ fill application
→ track result
```
---
# 2. Архітектура
```text
                         CLI
                          │
                          ▼
                   Local Service
                          │
               ┌──────────┴──────────┐
               │                     │
        Orchestration Core     Candidate Knowledge
               │                     │
     ┌─────────┼─────────┐           │
     │         │         │           │
 Search    Browser    Application    │
 Agents    Agents       Agents       │
     │         │         │           │
     └─────────┴─────────┴───────────┘
                          │
                    PostgreSQL
                          │
                  Vector / FTS index
```
CLI є тільки клієнтом. Бізнес-логіки всередині CLI немає.
Пізніше:
```text
CLI ─────────┐
             ├── Local Service → Core
macOS App ───┘
```
---
# 3. Candidate Profile
Глобальна інформація про кандидата:
```text
name
contacts
location
work authorization
preferred locations
remote preferences
salary expectations
languages
skills
technologies
years of experience
preferred roles
excluded roles
industries
employment type
constraints
preferences
```
Наприклад:
```yaml
roles:
  - AI Engineer
  - Backend Engineer
  - Founding Engineer
locations:
  - Remote EU
  - Greece
  - Cyprus
salary:
  minimum: 4000
  currency: EUR
exclude:
  - outstaff
  - relocation-only
```
---
# 4. Projects
`Project` - центральна сутність для опису досвіду.
Наприклад:
```text
Solovei
Ordi
AgentPass
Octify
Price Manager
...
```
Проєкт містить:
```text
name
description
period
my_role
my_responsibilities
what_i_personally_built
architecture
technical_decisions
problems_solved
challenges
business_context
business_impact
team
stack
sources
facts
evidence
```
---
# 5. Sources
До одного проєкту можна прив'язати необмежену кількість джерел:
```text
Project
├── GitHub repo
├── GitHub repo
├── website
├── documentation
├── Google Drive
├── PDF
├── text file
├── local directory
└── arbitrary URL
```
Тобто GitHub не є самим проєктом.
Він лише одне з джерел інформації про проєкт.
---
# 6. GitHub integration
GitHub connector може аналізувати:
- README;
- repository structure;
- languages;
- source code;
- commits;
- PR;
- issues;
- releases;
- документацію.
Весь repository не передається LLM щоразу.
Система попередньо будує:
```text
repo metadata
summaries
project facts
architecture summary
technology index
code evidence
embeddings
```
Потім агент отримує тільки релевантний контекст.
---
# 7. Evidence layer
Одна з ключових частин.
Кожне твердження про кандидата має provenance.
Наприклад:
```yaml
claim:
  text: Built a production AI call-analysis pipeline
evidence:
  project: Solovei
  source: github
  file: backend/pipeline/...
```
Або:
```yaml
claim:
  text: Led a team of 4 people
evidence:
  type: manual
```
Це потрібно, щоб агент не придумував досвід.
Для кожної відповіді можна буде подивитися:
```text
Answer:
"Designed an asynchronous speech-analysis pipeline..."
Based on:
✓ Solovei project description
✓ architecture.md
✓ repository code
✓ manual candidate fact
```
---
# 8. Candidate Knowledge Base
Усі джерела перетворюються на єдину базу знань:
```text
Candidate
├── Profile
├── Experience
├── Projects
│   ├── Facts
│   ├── Sources
│   └── Evidence
├── Skills
├── Cases
└── Previous application answers
```
Для retrieval використовуються:
- structured SQL queries;
- full-text search;
- embeddings;
- metadata filtering.
Не треба пхати весь досвід кандидата в context window.
---
# 9. Search Harness
Пошук виконують кілька незалежних стратегій.
Наприклад:
```text
Search Coordinator
├── AI / ML Search
├── Backend Search
├── Founding / CTO Search
├── Greece / Cyprus Search
├── Remote EU Search
├── ATS Search
└── Company Career Search
```
Вони можуть працювати паралельно.
---
# 10. Джерела вакансій
Не обмежуємось job boards.
Пошук:
```text
search engines
Greenhouse
Lever
Ashby
Workable
company career pages
specialized job boards
startup job boards
direct company crawling
RSS / API
```
Search Agent також може генерувати нові search strategies.
Наприклад:
```text
site:jobs.ashbyhq.com "AI Engineer" Europe
site:boards.greenhouse.io "LLM Engineer" remote
"Founding Engineer" "Europe" "Python"
```
---
# 11. Vacancy normalization
Усе приводиться до єдиного формату:
```text
company
title
description
location
remote_policy
employment_type
salary
currency
requirements
nice_to_have
technologies
source
original_url
apply_url
published_at
found_at
verified_at
```
---
# 12. Verification Agent
Не довіряємо просто search result.
Verifier відкриває вакансію і перевіряє:
```text
URL працює?
Вакансія ще існує?
Є Apply?
Apply веде на реальну форму?
Це не archived page?
Локація підходить?
Remote policy підходить?
Не duplicate?
```
Тому система не повинна приносити вакансії, де натискаєш Apply, а там головна сторінка компанії.
---
# 13. Deduplication
Одна вакансія може прийти з:
```text
Google
Greenhouse
job board
company site
```
Але зберігається як одна вакансія.
Dedup можна робити по:
```text
canonical URL
ATS ID
company + title
description similarity
```
---
# 14. Matching Agent
Після verification вакансія порівнюється з Candidate Knowledge Base.
Аналіз:
```text
must-have requirements
nice-to-have
candidate evidence
missing requirements
uncertain requirements
location
salary
language
remote policy
employment model
```
Результат не просто число.
Наприклад:
```text
Senior AI Engineer
Strong evidence:
✓ Python
✓ FastAPI
✓ LLM production systems
✓ agents
✓ Docker
✓ PostgreSQL
Partial:
~ PyTorch
Missing:
✗ Triton
Potential issue:
Daily spoken English calls
```
---
# 15. Company Research Agent
Для вакансій, які пройшли filtering:
```text
company product
business model
funding
size
team
founders
technology
recent developments
salary information
reviews
layoffs
remote culture
```
Research запускається не для кожної знайденої вакансії, а для тих, що реально цікаві.
---
# 16. Application Agent
Коли потрібна відповідь на питання:
> Tell us about a project where you built an LLM system in production.
Pipeline:
```text
Question
   ↓
Intent extraction
   ↓
Candidate KB retrieval
   ↓
Relevant projects
   ↓
Evidence selection
   ↓
Answer generation
   ↓
Fact verification
```
Наприклад він може знайти Solovei, а не просто переказати CV.
---
# 17. Previous answers
Система зберігає вже дані відповіді.
Наприклад:
```text
Why are you interested in this role?
Describe production AI experience.
Biggest technical challenge?
Describe leadership experience.
Salary expectations?
```
При наступній заявці агент може:
- reuse;
- адаптувати;
- оновити;
- знайти більш релевантний кейс.
Але не копіювати сліпо.
---
# 18. Browser automation
Для заявок:
```text
Playwright
   ↓
Application form
   ↓
field detection
   ↓
candidate data retrieval
   ↓
answer generation
   ↓
fill
```
Автоматично заповнюються:
```text
name
email
phone
location
salary
work authorization
GitHub
website
CV
LinkedIn якщо потрібен
```
Складні питання передаються Application Agent.
---
# 19. Jev
Jev використовуємо не як головний LLM, а для дешевих bounded decisions.
Наприклад:
```text
Which DOM element is Apply?
Is this field salary?
Is this vacancy still active?
Which option corresponds to Remote?
Should this vacancy go to verifier?
```
Це дозволяє не викликати Claude/Codex на кожну дрібницю.
---
# 20. Claude Code / Codex
Складні агенти запускаються через:
```text
Claude Code CLI
Codex CLI
```
Harness може використовувати існуючі підписки.
Вони потрібні для:
```text
planning
job analysis
candidate matching
research
answer generation
source analysis
complex browser reasoning
```
Harness не прив'язаний до одного provider.
Можна мати:
```yaml
agents:
  search_planner: codex
  matcher: claude
  researcher: codex
  application_writer: claude
```
---
# 21. Agent orchestration
Це саме harness, а не набір prompt-ів.
Він керує:
```text
tasks
dependencies
parallel workers
retries
timeouts
state
context
results
errors
agent lifecycle
```
Наприклад:
```text
Search run
├── worker #1
├── worker #2
├── worker #3
└── worker #4
       ↓
dedupe
       ↓
verification workers
       ↓
matching workers
       ↓
shortlist
```
---
# 22. Persistent memory
LLM не повинен пам'ятати всю історію.
Пам'ять живе поза моделлю:
```text
PostgreSQL
candidate knowledge
project facts
job history
application history
agent state
summaries
embeddings
```
Новий агент отримує лише потрібний контекст.
---
# 23. Application history
Система веде повну історію:
```text
discovered
reviewed
interested
skipped
prepared
applied
interview
rejected
offer
```
Також:
```text
application date
CV version
answers sent
salary specified
source
company contact
notes
```
---
# 24. Feedback
Команди типу:
```bash
job skip 173 --reason "salary too low"
job interested 182
job reject 194 --reason "too much frontend"
```
впливають на майбутній пошук.
Але система не повинна просто навчитися відкидати все схоже. Feedback є одним із сигналів, а не абсолютним правилом.
---
# 25. CLI
Приблизний UX:
```bash
jobs search
```
Запустити пошук.
```bash
jobs list
```
```text
ID   Company       Role                     Status
182  Acme AI       Senior AI Engineer       new
183  Foo Labs      Founding Engineer         matched
184  Bar Systems   Python Engineer           skipped
```
Деталі:
```bash
jobs show 182
```
```text
Senior AI Engineer
Acme AI
Remote EU
€5,000-7,000
Requirements
✓ Python
✓ FastAPI
✓ LLM
✓ agents
~ PyTorch
✗ Triton
Relevant experience
- Solovei
- AgentPass
Potential issues
- US overlap 2h/day
Source verified: yes
Apply page verified: yes
```
---
# 26. Candidate CLI
```bash
candidate show
candidate project list
candidate project add
candidate project show solovei
```
Sources:
```bash
candidate source add solovei github https://github.com/...
candidate source add solovei website https://...
candidate source add solovei file ./architecture.pdf
```
Sync:
```bash
candidate sync
candidate sync solovei
candidate sync github
```
---
# 27. Application CLI
```bash
jobs apply 182
```
Система готує заявку.
```bash
applications preview 182
```
Показує:
```text
Name: Roman ...
Salary: €6000
GitHub: ...
Question:
Describe an AI system you built.
Answer:
...
Evidence:
Solovei / project docs / GitHub
```
Після цього:
```bash
applications fill 182
```
Browser заповнює форму.
Submit я б залишив окремою явною дією:
```bash
applications submit 182
```
Щоб harness сам випадково не відправив неправильну заявку.
---
# 28. Background daemon
Щоб CLI не тримав process відкритим:
```text
jobd
```
Локальний daemon керує:
```text
workers
queues
browser
LLM sessions
scheduled searches
database
```
CLI просто спілкується з ним.
Наприклад:
```bash
jobs search
```
повертає:
```text
Search run #391 started.
12 workers running.
```
Потім:
```bash
runs show 391
```
---
# 29. Майбутній macOS app
Desktop app нічого принципово нового не додає.
Вона просто стає ще одним client:
```text
macOS UI
   ↓
local API
   ↓
той сам daemon
```
У ній можна буде зробити:
```text
Jobs
Applications
Companies
Projects
Candidate Profile
Agent Runs
Sources
Settings
```
Тому desktop треба врахувати в API зараз, але сам UI зараз робити нема сенсу.
---
# 30. Технологічно
Я б орієнтувався приблизно на:
```text
Python
FastAPI або lightweight RPC layer
PostgreSQL
pgvector
Playwright
Claude Code CLI
Codex CLI
Jev
GitHub API / git
background workers
asyncio
```
Не потрібні LangChain/LangGraph просто заради того, щоб вони були. Оркестрацію тут можна зробити своєю, бо вона є однією з головних частин продукту.
---
## В результаті
Це не просто агрегатор вакансій і не «бот, який шукає роботу».
Це **персональний job hunting harness**, який має довгострокову пам'ять про кандидата та його проєкти, сам шукає і перевіряє вакансії, розуміє відповідність вакансії реальному досвіду, досліджує компанії, готує специфічні відповіді на основі доказів, заповнює форми та веде весь application history.
А CLI зараз є просто першим клієнтом до цієї системи.