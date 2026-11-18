# Choobs — технический аудит перед Choobs 2.0

**Дата:** 2026-11-13

**Ветка:** `choobs-2.0-migration`
**Базовый commit:** `09974ce` (`main` на момент создания ветки)

## Общая оценка текущего состояния

Choobs — Electron-приложение с отдельным Go Core Manager, который запускает sing-box. Это рабочий прототип приложения для выборочной маршрутизации через локальный HTTP/SOCKS-прокси, а не полноценный системный VPN: фактически генерируется только VLESS outbound, TUN и маршрутизация всего трафика отсутствуют.

Положительная основа: узкий IPC-контракт, запуск core без shell, проверка конфигурации sing-box до запуска, ожидание локального proxy и проверка внешнего IP, ограниченные и редактируемые логи, восстановление Windows proxy, тестируемые интерфейсы менеджера и упаковщик portable-версии с проверкой целостности.

Основной разрыв перед 2.0 — несоответствие между тем, что подписки принимают и показывают, и тем, что runtime способен подключить. Импорт VLESS URI не означает поддержку его параметров: неизвестный `mode` отклоняется, а XHTTP отсутствует в генераторе. Из семи запрошенных протоколов только VLESS частично реализован для подключения.

Аудит сделан по исходникам, тестам, конфигурации сборки и метаданным имеющихся Windows PE-файлов. Это не было испытанием приложения на Windows 7, реальном VPN-сервере или реальной сети. Выводы, которые исходниками подтвердить нельзя, отмечены отдельно.

При подготовке ветки рабочая директория уже содержала незакоммиченные правки и неотслеживаемые файлы. Они сохранены и не изменялись. Аудит отражает исходники именно в этом состоянии; в частности, существующий незакоммиченный `core/README.md` противоречит реализации System Proxy, см. ниже.

## Архитектура проекта

- **Electron main** (`main.js`) создаёт окно, системный трей, хранит пользовательскую конфигурацию через `config-store.js`, обслуживает IPC и запускает Go Core Manager как дочерний процесс.
- **Preload** (`preload.js`) публикует ограниченный API через `contextBridge`; renderer не получает Node.js API. Окно использует `contextIsolation: true` и `nodeIntegration: false`.
- **Renderer** (`app/js/app.js`, `subscriptions.js`, `storage.js`) реализует UI, импорт/обновление подписок и отображение состояния. Секреты и профиль передаются main-процессу; запуск возможен по ID сохранённого сервера, после повторной проверки сохранённой записи.
- **Go Core Manager** (`backend/main.go`, `core_manager.go`) получает JSON Lines по stdin/stdout, принимает `start`, `stop`, `restart`, `status`, проверяет поля запроса и управляет sing-box через `os/exec`, без shell.
- **Генератор конфигурации** (`backend/config_generator.go`) преобразует выбранную запись в временный sing-box JSON. Менеджер выполняет `sing-box check`, запускает core, проверяет loopback listener и внешний IP через proxy.
- **Системная интеграция Windows** (`proxy_controller.go`, `system_proxy_windows.go`) временно меняет proxy-настройки текущего пользователя и пытается восстановить прежние. Для не-Windows платформ автоматическое применение proxy явно не поддерживается.
- **Упаковка** описана `package.json`, `scripts/build-installer.js`, `scripts/build-portable.js`; Go-пакет `backend/singlefile` упаковывает runtime в portable EXE и проверяет хеши извлечённых файлов.

## Что уже работает

- Подписки загружаются по HTTP(S), имеют ограничения по размеру/времени, обрабатывают редиректы и распространённые сжатия. Парсер понимает URI-списки, percent-encoded списки и Base64, в том числе URL-safe и без padding.
- Импорт/экспорт сохранённой JSON-конфигурации, CRUD подписок и серверов, избранное, выбор сервера, проверка TCP-доступности и основной UI подключены к desktop IPC.
- Для VLESS генератор валидирует UUID, адрес/порт и соответствие URI выбранной записи; поддерживает TCP и локальный `mixed` inbound на `127.0.0.1`.
- Для VLESS частично работают `security=none`, TLS и Reality; SNI/`serverName`, ALPN, ограниченный набор uTLS fingerprints, `xtls-rprx-vision` и Reality `pbk`/`sid` преобразуются в поля sing-box.
- Core запускается с проверкой конфига и локального listener; статус `running` выставляется только после HTTPS-проверки внешнего IP через proxy. Есть остановка/перезапуск, реакция на неожиданный выход и ограничение лог-файла 2 MiB.
- Windows System Proxy сохраняет исходные значения `ProxyEnable`, `ProxyServer`, `ProxyOverride`, `AutoConfigURL`; перед восстановлением сравнивает текущее значение с тем, которое установил Choobs. Есть rollback, recovery-состояние и восстановление при старте/выходе процесса.
- Portable-упаковщик проверяет SHA-256 runtime, manifest и пути ZIP-архива; извлекает runtime в пользовательскую директорию. Проверка сценария упаковщика поддержана unit-тестами.

## Что работает частично

- **VLESS:** работает ограниченная комбинация TCP + none/TLS/Reality. Принимаются только `flow=xtls-rprx-vision` (только с Reality), поддерживаемые fingerprints и разобранные TLS-параметры. Это не полная реализация VLESS URI и не поддержка всех конфигураций sing-box.
- **VMess, Trojan, Shadowsocks:** импортируются и отображаются, но генератор конфигурации откажет при попытке подключения. В VMess сохраняются декодированные данные, однако Core Manager использует URI/общие поля и отдельной реализации VMess outbound в коде нет.
- **System Proxy:** работает как настройка proxy пользователя Windows, а не как перенаправление всего системного трафика. Изменение реестра proxy не является TUN и не обеспечивает kill switch или гарантированное отсутствие DNS-leak.
- **Ошибки:** генератор возвращает конкретные причины, но классификация `ErrorCode` в `CoreManager.Start` основана на подстроках текста и не всегда отделяет неподдерживаемые параметры от невалидной конфигурации.
- **Windows 7:** есть намеренный legacy build path и зафиксированные версии/хеши в README и скриптах, но реальная совместимость конкретных установщика и runtime на Windows 7 из успешной компиляции или PE-архитектуры не следует.

## Что отсутствует

- VLESS XHTTP и его `mode`; также отсутствуют VLESS WebSocket и gRPC как runtime transports.
- Подключение через VMess, Trojan, Shadowsocks, Hysteria2, TUIC и WireGuard.
- TUN inbound, системная маршрутизация, DNS-интеграция, kill switch и политики split/full tunnel.
- Реальный выбор режима подключения в UI: сохранение значений `System Proxy`, `TUN`, `Auto` в настройках само по себе не реализует соответствующие режимы. UI сообщает `Traffic mode: System Proxy`, а runtime всегда сообщает `proxy`.
- Подтверждённый системный end-to-end тест на Windows 7 x64, тесты реальных Windows Registry/WinINet API и CI-матрица по поддерживаемым Windows.
- Запуск integration-теста с реальным sing-box и VLESS сервером в рамках этого аудита: тест требует `-tags=integration` и пользовательские `CHOOBS_TEST_VLESS_*`.

## Найденные ошибки и ограничения

### `unsupported VLESS parameter mode`

`GenerateRuntimeConfig` перечисляет разрешённые query-параметры; `mode` в список не входит. Поэтому VLESS URI с `mode=...` получает ошибку формата `Unsupported VLESS parameter: mode`. Парсер подписки при этом может импортировать такой VLESS URI и сохранить его без проверки семантики — отказ возникает при запуске.

Классификация этой ошибки дополнительно неверна: `CoreManager.Start` относит неподдерживаемую конфигурацию к `UNSUPPORTED_PROTOCOL`, только если текст содержит подстроку `not supported` или `not implemented`. Сообщение `Unsupported VLESS parameter: mode` не совпадает с этими проверками из-за формулировки/регистра, поэтому возвращается `CONFIG_INVALID`. Это затрудняет точное отображение и обработку ошибки.

### Отсутствие VLESS XHTTP

XHTTP не реализован: `type=xhttp` отклоняется проверкой транспорта, поскольку поддерживается только `tcp`; `mode` отклоняется ещё раньше как неизвестный query-параметр. Другие типичные параметры транспорта, например `host`, `path` и `serviceName`, также прямо объявлены не реализованными. Порядок обхода неизвестных query-ключей в Go map не фиксирован, поэтому URI с несколькими неподдержанными параметрами может сообщать разные первые причины.

### Прочие ограничения

- Набор протоколов в `subscriptions.js` ограничен VLESS, VMess, Trojan, SS, SOCKS5 и HTTPS. Hysteria2, TUIC и WireGuard распознаются как неподдерживаемые записи и пропускаются.
- `config-store.js` также не разрешает Hysteria2/TUIC/WireGuard как сохранённые значения протокола; неизвестное значение нормализуется как HTTPS, что может исказить импортируемые данные, если запись попадёт в этот нормализатор.
- TLS/Reality-параметры отображаются только в пределах явных проверок генератора. Неизвестные параметры не игнорируются молча, но пользователь не получает список всех недостающих возможностей до подключения.
- `TrafficModeTUN` объявлен в Go, но не используется при генерации конфига или управлении трафиком.
- В текущем незакоммиченном `core/README.md` сказано, что приложение автоматически не меняет Windows System Proxy. Это противоречит `CoreManager.Start` и Windows proxy controller, которые применяют настройки. Документацию необходимо согласовать с кодом до миграции.
- В текущем окружении доступны Go `1.27.1` и Node `v24.21.0`; это не подтверждает, каким компилятором были собраны имеющиеся EXE или их работу на Windows 7. Build scripts для release требуют Go `1.20.14`.

## Таблица функций и необходимых изменений

Статусы: **Работает** — подтверждено кодом и/или тестом; **Частично** — есть реализация с существенными ограничениями; **Нет** — реализации не найдено; **Не подтверждено** — исходники не доказывают работу целевой платформы.

| Функция | Текущая реализация | Статус | Основные файлы | Необходимые изменения для 2.0 |
|---|---|---|---|---|
| Electron ↔ Go IPC | Preload API, main-process JSON Lines, команды start/stop/restart/status | Работает | `main.js`, `preload.js`, `backend/main.go` | Версионировать DTO/протокол IPC, формализовать ошибки и переходы состояния |
| Жизненный цикл core | Go `os/exec`, конфиг-check, ожидание listener, stop/kill, health-check, обработка неожиданного выхода | Частично | `backend/core_manager.go`, `backend/core_manager_test.go` | Явная state machine, таймауты/отмена, согласованная обработка гонок остановки и выхода |
| VLESS over TCP | UUID/address checks, `mixed` loopback inbound, sing-box VLESS outbound | Частично | `backend/config_generator.go`, `backend/core_manager.go` | Схемы профиля и возможности транспорта, table-driven конфигурационные тесты |
| `mode` в VLESS URI | Неизвестный параметр отвергается; error code ошибочно классифицируется как `CONFIG_INVALID` | Ошибка/ограничение | `backend/config_generator.go`, `backend/core_manager.go` | Поддержать допустимые значения там, где они применимы; иначе выдавать структурированную `unsupported_parameter` ошибку |
| VLESS Reality | `pbk`/`publicKey`, `sid`/`shortId`, SNI, fingerprint и Reality outbound | Частично | `backend/config_generator.go`, `backend/core_manager_test.go` | Зафиксировать поддерживаемые URI-диалекты и тестировать против закреплённой версии core |
| VLESS Vision | Только `xtls-rprx-vision`, только с Reality | Частично | `backend/config_generator.go` | Проверять совместимость flow с transport/security и тестировать реальные профили |
| VLESS TLS, SNI, ALPN, fingerprint | TLS/Reality, `sni`/`serverName`, ALPN и allowlist fingerprint | Частично | `backend/config_generator.go` | Явная capability-схема, унификация aliases, негативные/позитивные тесты на каждый параметр |
| VLESS XHTTP | `mode` неизвестен; `type=xhttp` и transport-параметры не реализованы | Нет | `backend/config_generator.go`, `tests/subscriptions.test.js` | Спецификация URI-маппинга и XHTTP outbound для выбранной версии sing-box; тест check и интеграция |
| VLESS WebSocket / gRPC | `type=ws`/`grpc` отклоняется; `host`/`path`/`serviceName` не генерируются | Нет | `backend/config_generator.go`, `backend/core_manager_test.go` | Добавлять независимо, с проверенными полями sing-box и end-to-end тестами |
| VMess | URI/Base64 парсятся и сервер показывается; runtime outbound отсутствует | Частично | `app/js/subscriptions.js`, `backend/config_generator.go` | Реализовать типизированный VMess профиль и конфиг либо явно запретить запуск в UI |
| Trojan / Shadowsocks | URI импортируется/показывается; runtime outbound отсутствует | Частично | `app/js/subscriptions.js`, `backend/config_generator.go` | Аналогично VMess; сопоставить все обязательные параметры со схемой Core |
| Hysteria2 / TUIC / WireGuard | Нет схем URI/профилей и runtime outbound; записи пропускаются | Нет | `app/js/subscriptions.js`, `config-store.js`, `backend/config_generator.go` | Добавлять в parser, storage schema, UI и backend как согласованные вертикальные срезы |
| System Proxy | Windows registry + WinINet; сохраняет/восстанавливает значения текущего пользователя | Работает с ограничениями | `backend/proxy_controller.go`, `backend/system_proxy_windows.go`, `backend/proxy_controller_test.go` | Изолировать OS adapter, тестировать на Windows, согласовать docs; не называть полным VPN |
| TUN / DNS / маршрутизация | Реализации нет; core-конфиг содержит только loopback `mixed` inbound | Нет | `backend/config_generator.go`, `backend/proxy_controller.go`, `app/js/app.js` | Отдельный TUN/DNS/routing subsystem, права/драйвер, rollback, kill switch и проверка DNS-leak |
| Импорт подписок | HTTP(S), лимиты, Base64/percent URI; парсер поддерживает 6 схем, включая SOCKS5/HTTPS | Частично | `main.js`, `app/js/subscriptions.js`, `tests/subscriptions.test.js` | Общий parser contract, форматы/протоколы из capability matrix, тесты malformed и больших feed |
| Настройки режимов | Сохраняются `System Proxy`/`TUN`/`Auto`, но UI показывает только System Proxy, backend режим не выбирает | Частично | `config-store.js`, `app/js/storage.js`, `app/js/app.js` | Удалить неисполняемые настройки или реализовать выбор/проверку режима end-to-end |
| Windows 7 x64 packaging | Electron 22.3.27, x64 target, Go 1.20.14 release requirement; legacy sing-box hash закреплён в scripts | Не подтверждено на целевой ОС | `package.json`, `core/README.md`, `scripts/build-installer.js`, `scripts/build-portable.js` | Отдельный reproducible legacy pipeline и VM-тест установки, запуска, proxy, disconnect/uninstall |
| Тесты | Go unit, JS node:test, integration test с opt-in реальным сервером | Частично | `backend/*_test.go`, `backend/singlefile/singlefile_test.go`, `tests/*.test.js` | Добавить protocol matrix, XHTTP/mode regression, Windows API и E2E/Win7 CI |

### Поддержка протоколов: импорт против подключения

| Протокол | Импорт/отображение | Подключение через текущий Core Manager |
|---|---|---|
| VLESS | Да | Частично: TCP + ограниченные security/flow параметры |
| VMess | Да, включая Base64 JSON | Нет |
| Trojan | Да | Нет |
| Shadowsocks | Да, схема `ss://` | Нет |
| Hysteria2 | Нет, диагностируется как unsupported и пропускается | Нет |
| TUIC | Нет, поддержка не найдена | Нет |
| WireGuard | Нет, поддержка не найдена | Нет |

## Совместимость с Windows 7

**Найденные признаки намеренной поддержки, но не доказательство запуска:**

- `package.json` фиксирует Electron `22.3.27` и target Windows x64. `core/README.md` обозначает sing-box v1.10.7 legacy-сборку и Go 1.20.14 как целевую комбинацию; build scripts проверяют Electron/builder версии и SHA-256 sing-box.
- `backend/go.mod` объявляет Go 1.20. Скрипты сборки менеджера требуют Go 1.20.14 и используют `CGO_ENABLED=0`, `GOOS=windows`, `GOARCH=amd64`. Portable bootstrap проверяет PE32+ x86-64 и subsystem version не новее Windows 7.
- Проверенный в этом аудите файл `core/bin/sing-box.exe` — PE32+ x86-64; SHA-256 совпадает со значением, зафиксированным в build scripts. `backend/choobs-core-manager.exe` и `dist/Choobs.exe` также имеют PE32+ x86-64 метаданные.
- Windows System Proxy использует Win32 Registry и WinINet API, но unit-тесты работают на fake store, а не на Windows 7 API.

**Что остаётся неподтверждённым:** установка NSIS на Windows 7, запуск Electron app и child processes, запуск конкретных бинарей на Windows 7 x64, требования TLS/сертификатов и сетевых библиотек, корректность tray/автозапуска, изменение и восстановление реального user proxy. PE-архитектура и сборочная цель этого не доказывают. `dist/Choobs.exe` не запускался на Windows 7; Windows среда в этом аудите отсутствовала. Кроме того, фактическая сборка с обязательным Go 1.20.14 не выполнялась.

До заявления поддержки необходима тестовая VM/машина Windows 7 x64 и проверка полного цикла: установка/portable extraction → запуск → supported VLESS connection → HTTP(S) traffic через proxy → выход/аварийный выход → восстановление proxy → повторный запуск/uninstall. Тестировать отдельно installer и portable artifact.

## Рекомендуемая архитектура Choobs 2.0

1. **Разделить UI и доменную модель.** Electron renderer отвечает только за UX; main process — за IPC, данные и жизненный цикл приложения; Go service — за профили, сборку конфигурации, процессы и системный routing adapter. Зафиксировать versioned IPC DTO и статусы/ошибки без зависимости от текста сообщений.
2. **Ввести каноническую модель профиля.** Parser для каждой URI-схемы переводит данные в версионируемый типизированный профиль. Импорт и runtime generation используют одну модель; неизвестный параметр не должен теряться или приводить к несвязанной ошибке. UI показывает возможности профиля до подключения.
3. **Изолировать VPN Core за адаптером.** Вынести sing-box версию и конфигурацию в версионируемый adapter с capability matrix: protocol × security × flow × transport. Генератор каждого профиля проверяется unit-тестом и командой `sing-box check` для закреплённой сборки; upgrade core — отдельное миграционное решение.
4. **Разделить режимы маршрутизации.** System Proxy и TUN — отдельные backend adapters с явным состоянием, rollback/recovery и проверкой здоровья. TUN не включать до реализации DNS, маршрутов, прав/драйвера, kill switch и защиты от утечек. Статус `connected` должен отражать не просто процесс, а выбранный режим и успешные проверки.
5. **Сохранить границу платформы.** Windows registry/WinINet, TUN и права администратора — за интерфейсами платформенных реализаций. Собирать и тестировать legacy Win7 и актуальные Windows как отдельные матрицы; не смешивать требования Go/Electron нового release с legacy target.
6. **Обеспечить наблюдаемость и безопасность ошибок.** Использовать машинно-читаемые code/category/field/path; безопасно показывать причину, скрывать credentials/URI из логов и диагностик; сохранить bounded logs и recovery state.

## Поэтапный план миграции

1. **Зафиксировать базовую линию.** Сохранить текущие результаты тестов, инвентаризировать сохранённые форматы и решить: остаётся ли Windows 7 целевой ОС для 2.0 или только legacy-ветки. Не менять текущий формат без мигратора.
2. **Сделать профиль и capability matrix.** Определить нормализованную модель, versioning, parser errors и поведение неизвестных параметров. Добавить тесты URI round-trip и ошибку для `mode` с верным стабильным кодом.
3. **Закрыть ближайший VLESS-разрыв.** Сначала описать используемый XHTTP URI dialect и параметры `mode`/`host`/`path`; затем реализовать XHTTP mapping для закреплённой версии sing-box. Добавить fixtures, проверку `sing-box check` и тест соединения. До этого показывать понятный unsupported transport, а не обещать поддержку.
4. **Разнести генераторы протоколов.** Подключать отдельными вертикальными срезами VLESS transports, затем VMess/Trojan/Shadowsocks и после оценки требований Hysteria2/TUIC/WireGuard: parser → storage migration → UI → generator → integration test. Не отмечать протокол supported только по факту его импорта.
5. **Стабилизировать process supervisor и routing.** Зафиксировать state machine, таймауты, отмену, восстановление proxy после аварии. Затем отдельным проектированием реализовать TUN/DNS/routes или явно исключить их из scope 2.0.
6. **Сформировать release matrix.** Зафиксировать версии Electron/Go/Core/NSIS, повторяемую сборку, хеши и подпись; прогнать installer и portable на Windows 7 x64 (если поддерживается) и актуальной Windows. Тестировать реальные proxy settings, DNS, перезапуски, crash и uninstall.
7. **Перевести пользователей постепенно.** Мигрировать конфиги с проверкой/backup, сохранять старые поля, логировать только безопасные результаты, предусмотреть rollback и не удалять старые runtime до подтверждения успешного запуска новой версии.

## Риски и способы их избежать

| Риск | Как избежать |
|---|---|
| UI показывает импортируемый сервер как подключаемый, хотя runtime его не умеет | Capability matrix в модели; UI блокирует Connect с конкретной причиной; тест на каждый поддерживаемый протокол |
| Неполная трактовка XHTTP `mode` или Reality/flow создаёт неправильный tunnel | Зафиксировать dialect и версию sing-box; валидировать поля; test fixtures + sing-box check + реальный controlled endpoint |
| Обновление sing-box меняет JSON schema или поведение протокола | Версионировать core adapter, закреплять бинарь checksum/signature, не обновлять core независимо от тестового набора |
| Изменение System Proxy/TUN оставляет пользователя без сети или перезаписывает пользовательские настройки | Transactional apply/rollback, сравнение состояния, durable recovery, аварийные и ручные тесты на Windows |
| Заявленная совместимость с Windows 7 основана только на target x64/PE | Раздельные legacy builds и испытания на чистой Windows 7 x64 VM; фиксировать реальные результаты каждой версии |
| Изменение JSON-профиля ломает существующие настройки | Версионированный формат, миграции с backup, обратная совместимость и round-trip fixtures |
| Текущая документация и код расходятся | Согласовать core README с фактическим System Proxy и генерировать release notes из проверяемых capabilities |
| Диагностика выдаёт неверную категорию/может раскрыть чувствительные данные | Структурированные error codes, редактирование credentials, тесты на секреты в ошибках и логах |

## Тесты и верификация аудита

- `node --test tests/*.test.js`: **24 теста пройдены, 0 ошибок** (IPC, подписки, config store, UI state).
- `go -C backend test ./...`: **успешно** для `choobs/backend` и `choobs/backend/singlefile`; bootstrap/pack не содержат тестов. Integration-тест с реальным сервером запускался бы отдельно с build tag `integration` и пользовательскими параметрами — в этом аудите не запускался.
- Тесты Windows proxy используют in-memory fake registry store; фактический Windows API и Windows 7 не тестировались.
- SHA-256 `core/bin/sing-box.exe` совпал с hash, ожидаемым build scripts; `file` подтвердил PE32+ x86-64 для core, manager и portable EXE. Эти проверки не доказывают работу на Windows 7.

## Изученные файлы и артефакты

- Electron/UI: `main.js`, `preload.js`, `config-store.js`, `app/js/app.js`, `app/js/subscriptions.js`, `app/js/storage.js`.
- Backend: `backend/go.mod`, `backend/main.go`, `backend/core_manager.go`, `backend/config_generator.go`, `backend/proxy_controller.go`, `backend/system_proxy_windows.go`, `backend/system_proxy_other.go`.
- Core/сборка: `README.md`, `core/README.md`, `core/configs/README.md`, `package.json`, `scripts/build-installer.js`, `scripts/build-portable.js`.
- Тесты: `backend/core_manager_test.go`, `backend/proxy_controller_test.go`, `backend/core_integration_test.go`, `backend/singlefile/singlefile_test.go`, `tests/core-ipc.test.js`, `tests/subscriptions.test.js`, `tests/config-store.test.js`, `tests/ui-state.test.js`.
- Метаданные бинарников: `core/bin/sing-box.exe`, `backend/choobs-core-manager.exe`, `dist/Choobs.exe` (тип PE/архитектура и SHA-256; бинарники не запускались на Windows).
