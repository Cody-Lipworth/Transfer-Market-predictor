      // Single place to point this canvas at a different backend later (there's no
      // build-time env var system in a static DC artifact, so this constant is the
      // equivalent of VITE_API_BASE_URL / NEXT_PUBLIC_API_BASE_URL).
      const API_BASE_URL = 'http://localhost:8000';

      const POS_COLORS = { GK: '#f2b134', DEF: '#4d9de0', MID: '#57c98a', FWD: '#ff6452' };
      // Real season range in the backend's dataset (Kaggle Transfermarkt snapshot),
      // most recent first. There's no endpoint to list distinct seasons, so this
      // mirrors what `data/processed/dataset.csv` actually contains.
      const CURRENT_SEASON = 2025;
      const SEASON_LIST = Array.from({ length: 14 }, (_, i) => 2025 - i);

      function seasonLabel(season) { return String(season) + '/' + String((season + 1) % 100).padStart(2, '0'); }
      function formatMoney(v) {
        if (v == null) return '—';
        if (v >= 1000000) return '€' + (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        return '€' + Math.round(v / 1000) + 'K';
      }
      function formatMinutes(v) { return v.toLocaleString('en-US') + ' mins'; }
      function formatPct(v) { return Math.round(v * 100) + '%'; }
      function initialsOf(name) { return name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase(); }

      async function apiGet(path) {
        let res;
        try {
          res = await fetch(API_BASE_URL + path);
        } catch (e) {
          return { ok: false, status: 0, error: 'Could not reach the backend at ' + API_BASE_URL + '. Is uvicorn running?' };
        }
        let body = null;
        try { body = await res.json(); } catch (e) { body = null; }
        if (!res.ok) {
          return { ok: false, status: res.status, error: errorMessage(body, res.status), data: body };
        }
        if (body == null) {
          return { ok: false, status: res.status, error: 'The backend returned an empty or invalid response.' };
        }
        return { ok: true, status: res.status, data: body };
      }

      async function apiPost(path, payload) {
        let res;
        try {
          res = await fetch(API_BASE_URL + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
        } catch (e) {
          return { ok: false, status: 0, error: 'Could not reach the backend at ' + API_BASE_URL + '. Is uvicorn running?' };
        }
        let body = null;
        try { body = await res.json(); } catch (e) { body = null; }
        if (!res.ok) {
          return { ok: false, status: res.status, error: errorMessage(body, res.status), data: body };
        }
        if (body == null) {
          return { ok: false, status: res.status, error: 'The backend returned an empty or invalid response.' };
        }
        return { ok: true, status: res.status, data: body };
      }

      function errorMessage(body, status) {
        const detail = body && body.detail;
        if (typeof detail === 'string') return detail;
        if (Array.isArray(detail)) {
          return detail.map(d => (Array.isArray(d.loc) ? d.loc.slice(1).join('.') + ': ' : '') + d.msg).join('; ');
        }
        return 'Request failed (HTTP ' + status + ')';
      }

      class Component extends DCLogic {
        state = {
          view: 'directory',
          navSearchInput: '',
          directorySeason: CURRENT_SEASON,
          positionFilter: 'All',
          dirSearchInput: '', dirSearchQuery: '',
          sortKey: 'market_value_eur', sortDir: 'desc',
          players: [],
          directoryLoading: true, directoryRefreshing: false, directoryError: null, directoryLastUpdated: null,
          isMobile: false,
          // URLs that failed to actually load (404, network error, etc.) - once an
          // image_url fails we permanently fall back to the initials avatar for it
          // instead of retrying every render.
          imageLoadFailures: new Set(),
          healthStatus: 'checking',
          detailPlayerName: null, detailSeason: null, detail: null,
          detailLoading: false, detailRefreshing: false, detailError: null, detailLastUpdated: null,
          notFoundName: null,
          form: { goals: '', assists: '', age: '', minutes_played: '', position_group: 'MID', minutes_share: '100' },
          formErrors: {},
          predictLoading: false, predictResult: null, predictError: null
        };

        componentDidMount() {
          this._checkMobile();
          this._resizeHandler = () => this._checkMobile();
          window.addEventListener('resize', this._resizeHandler);
          this.checkHealth();
          this.fetchDirectory(this.state.directorySeason);
        }
        componentWillUnmount() { window.removeEventListener('resize', this._resizeHandler); }

        handleImageError = (url) => {
          this.setState(s => {
            if (s.imageLoadFailures.has(url)) return null;
            const next = new Set(s.imageLoadFailures);
            next.add(url);
            return { imageLoadFailures: next };
          });
        };
        _checkMobile() { this.setState({ isMobile: window.innerWidth < 760 }); }

        checkHealth = async () => {
          const result = await apiGet('/health');
          this.setState({ healthStatus: result.ok ? 'connected' : 'unreachable' });
        };

        goToDirectory = () => this.setState({ view: 'directory' });
        goToPredict = () => this.setState({ view: 'predict' });

        fetchDirectory = async (season) => {
          this.setState({ directoryLoading: true, directoryError: null });
          const result = await apiGet('/players?season=' + encodeURIComponent(season));
          if (!result.ok) {
            this.setState({ directoryLoading: false, directoryError: result.error });
            return;
          }
          this.setState({ directoryLoading: false, directoryError: null, players: result.data, directoryLastUpdated: Date.now() });
        };

        refreshDirectory = async () => {
          this.setState({ directoryRefreshing: true });
          const result = await apiGet('/players?season=' + encodeURIComponent(this.state.directorySeason));
          if (!result.ok) {
            this.setState({ directoryRefreshing: false, directoryError: result.error });
            return;
          }
          this.setState({ directoryRefreshing: false, directoryError: null, players: result.data, directoryLastUpdated: Date.now() });
        };

        retryDirectory = () => this.fetchDirectory(this.state.directorySeason);

        onDirectorySeasonChange = (e) => {
          const season = Number(e.target.value);
          this.setState({ directorySeason: season });
          this.fetchDirectory(season);
        };

        // Nav-bar global search: we don't know if this player exists at all, so a
        // 404 here means "no such player" -> full Not Found page.
        onNavSearchSubmit = async () => {
          const query = this.state.navSearchInput.trim();
          if (!query) return;
          this.setState({ view: 'detail', detailLoading: true, detailError: null, detail: null, detailPlayerName: query, detailSeason: null });
          const result = await apiGet('/players/' + encodeURIComponent(query));
          if (!result.ok) {
            if (result.status === 404) {
              this.setState({ view: 'notfound', notFoundName: query, detailLoading: false });
            } else {
              this.setState({ detailLoading: false, detailError: result.error });
            }
            return;
          }
          const rec = result.data;
          this.setState({
            detailLoading: false, detailError: null, detail: rec,
            detailPlayerName: rec.name, detailSeason: rec.season,
            detailLastUpdated: Date.now()
          });
        };
        onNavSearchKeyDown = (e) => { if (e.key === 'Enter') this.onNavSearchSubmit(); };
        onNavSearchChange = (e) => this.setState({ navSearchInput: e.target.value });

        // Directory row click / season dropdown on an already-open detail page: we
        // already know the player exists, so a 404 here means "no row for that
        // season" -> the inline "No data for this season" state, not Not Found.
        openDetail = async (name, season) => {
          this.setState({ view: 'detail', detailPlayerName: name, detailSeason: season, detail: null, detailLoading: true, detailError: null });
          const result = await apiGet('/players/' + encodeURIComponent(name) + '?season=' + encodeURIComponent(season));
          if (!result.ok) {
            if (result.status === 404) {
              this.setState({ detailLoading: false, detail: null });
            } else {
              this.setState({ detailLoading: false, detailError: result.error });
            }
            return;
          }
          this.setState({ detailLoading: false, detailError: null, detail: result.data, detailLastUpdated: Date.now() });
        };

        onDetailSeasonChange = (e) => {
          const season = Number(e.target.value);
          this.openDetail(this.state.detailPlayerName, season);
        };

        refreshDetail = async () => {
          this.setState({ detailRefreshing: true });
          const result = await apiGet('/players/' + encodeURIComponent(this.state.detailPlayerName) + '?season=' + encodeURIComponent(this.state.detailSeason));
          if (!result.ok) {
            if (result.status === 404) {
              this.setState({ detailRefreshing: false, detail: null });
            } else {
              this.setState({ detailRefreshing: false, detailError: result.error });
            }
            return;
          }
          this.setState({ detailRefreshing: false, detailError: null, detail: result.data, detailLastUpdated: Date.now() });
        };

        retryDetail = () => this.openDetail(this.state.detailPlayerName, this.state.detailSeason);

        setPositionFilter = (pos) => this.setState({ positionFilter: pos });
        onDirSearchChange = (e) => this.setState({ dirSearchInput: e.target.value });
        onDirSearchKeyDown = (e) => { if (e.key === 'Enter') this.setState({ dirSearchQuery: this.state.dirSearchInput.trim() }); };
        clearDirSearch = () => this.setState({ dirSearchInput: '', dirSearchQuery: '' });
        sortBy = (key) => this.setState(s => ({ sortKey: key, sortDir: s.sortKey === key && s.sortDir === 'desc' ? 'asc' : 'desc' }));

        onFieldChange = (field, e) => this.setState(s => ({ form: { ...s.form, [field]: e.target.value } }));

        submitPredict = async () => {
          const f = this.state.form;
          const errors = {};
          if (f.goals === '' || f.goals == null) errors.goals = 'Required';
          if (f.assists === '' || f.assists == null) errors.assists = 'Required';
          if (f.age === '' || f.age == null) errors.age = 'Required';
          if (f.minutes_played === '' || f.minutes_played == null) errors.minutes_played = 'Required';
          if (f.minutes_share !== '' && f.minutes_share != null) {
            const v = Number(f.minutes_share);
            if (v < 0 || v > 100) errors.minutes_share = 'Must be between 0 and 100%';
          }
          if (Object.keys(errors).length) { this.setState({ formErrors: errors }); return; }
          this.setState({ formErrors: {}, predictLoading: true, predictResult: null, predictError: null });

          const payload = {
            goals: Number(f.goals), assists: Number(f.assists), age: Number(f.age),
            minutes_played: Number(f.minutes_played), position_group: f.position_group,
            minutes_share: f.minutes_share === '' ? 1 : Number(f.minutes_share) / 100
          };
          const result = await apiPost('/predict', payload);
          if (!result.ok) {
            this.setState({ predictLoading: false, predictError: result.error });
            return;
          }
          this.setState({ predictLoading: false, predictResult: result.data.predicted_value_eur });
        };

        _lastUpdatedText(ts) {
          if (!ts) return '';
          return 'Updated ' + new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        renderVals() {
          const s = this.state;
          const seasonOptions = SEASON_LIST.map(sn => ({ value: sn, label: seasonLabel(sn) }));
          const positionOptions = ['All', 'GK', 'DEF', 'MID', 'FWD'].map(p => ({
            label: p, onClick: () => this.setPositionFilter(p),
            color: s.positionFilter === p ? '#0b0b0c' : (POS_COLORS[p] || '#c9c9cd'),
            bg: s.positionFilter === p ? '#f2f1ee' : 'transparent'
          }));

          let filteredPlayers = s.players;
          if (s.positionFilter !== 'All') filteredPlayers = filteredPlayers.filter(p => p.position_group === s.positionFilter);
          if (s.dirSearchQuery) filteredPlayers = filteredPlayers.filter(p => p.name.toLowerCase().includes(s.dirSearchQuery.toLowerCase()));

          const sk = s.sortKey, dir = s.sortDir === 'asc' ? 1 : -1;
          filteredPlayers = [...filteredPlayers].sort((a, b) => {
            const av = a[sk], bv = b[sk];
            if (typeof av === 'string') return av.localeCompare(bv) * dir;
            return (av - bv) * dir;
          });

          const tableRows = filteredPlayers.map(p => ({
            ...p,
            posColor: POS_COLORS[p.position_group],
            initials: initialsOf(p.name),
            ageFmt: p.age.toFixed(1),
            hasImage: !!p.image_url && !s.imageLoadFailures.has(p.image_url),
            onImageError: () => this.handleImageError(p.image_url),
            valueFmt: formatMoney(p.market_value_eur),
            minutesFmt: formatMinutes(p.minutes_played),
            minutesShareFmt: formatPct(p.minutes_share),
            g90: p.goals_per_90.toFixed(2),
            a90: p.assists_per_90.toFixed(2),
            rowBg: 'transparent',
            onClick: () => this.openDetail(p.name, p.season)
          }));

          const NUMERIC_COLUMNS = new Set(['age', 'goals', 'assists', 'goals_per_90', 'assists_per_90', 'minutes_played', 'minutes_share', 'market_value_eur']);
          const columns = [
            { key: 'photo', label: '' },
            { key: 'name', label: 'Name' },
            { key: 'position_group', label: 'Pos' },
            { key: 'age', label: 'Age' },
            { key: 'goals', label: 'G' },
            { key: 'assists', label: 'A' },
            { key: 'goals_per_90', label: 'G/90' },
            { key: 'assists_per_90', label: 'A/90' },
            { key: 'minutes_played', label: 'Mins' },
            { key: 'minutes_share', label: 'Min%' },
            { key: 'market_value_eur', label: 'Value' }
          ].map(c => ({
            ...c,
            onClick: () => this.sortBy(c.key),
            sortIndicator: s.sortKey === c.key ? (s.sortDir === 'desc' ? ' ▼' : ' ▲') : '',
            justify: NUMERIC_COLUMNS.has(c.key) ? 'flex-end' : 'flex-start'
          }));

          const colTemplate = '44px 1.6fr 0.7fr 0.5fr 0.5fr 0.5fr 0.6fr 0.6fr 0.9fr 0.6fr 0.9fr';

          let detail = null;
          if (s.detail) {
            const rec = s.detail;
            const predicted = rec.predicted_value_eur;
            const maxVal = Math.max(rec.market_value_eur, predicted, 1);
            const delta = predicted - rec.market_value_eur;
            detail = {
              ...rec, posColor: POS_COLORS[rec.position_group], initials: initialsOf(rec.name),
              ageFmt: rec.age.toFixed(1),
              hasImage: !!rec.image_url && !s.imageLoadFailures.has(rec.image_url),
              onImageError: () => this.handleImageError(rec.image_url),
              valueFmt: formatMoney(rec.market_value_eur), predictedFmt: formatMoney(predicted),
              minutesFmt: formatMinutes(rec.minutes_played), minutesShareFmt: formatPct(rec.minutes_share),
              g90: rec.goals_per_90.toFixed(2), a90: rec.assists_per_90.toFixed(2),
              yearsFromPeakLabel: (rec.years_from_peak >= 0 ? '+' : '') + rec.years_from_peak.toFixed(1) + ' yrs from peak',
              deltaFmt: (delta >= 0 ? '+' : '−') + formatMoney(Math.abs(delta)), deltaColor: delta >= 0 ? '#57c98a' : '#ff6452',
              actualBarPct: Math.round((rec.market_value_eur / maxVal) * 100), predictedBarPct: Math.round((predicted / maxVal) * 100)
            };
          }
          const showDetailContent = !s.detailLoading && !s.detailError && !!detail;
          const showDetailNoSeason = !s.detailLoading && !s.detailError && !detail && !!s.detailPlayerName;
          const showDetailError = !s.detailLoading && !!s.detailError;
          const detailSeasonLabel = s.detailSeason != null ? seasonLabel(s.detailSeason) : '';

          const formBorder = {};
          ['goals', 'assists', 'age', 'minutes_played', 'minutes_share', 'position_group'].forEach(f => { formBorder[f] = s.formErrors[f] ? '#ff6452' : '#2b2b30'; });

          return {
            isDirectory: s.view === 'directory', isDetail: s.view === 'detail', isNotFound: s.view === 'notfound', isPredict: s.view === 'predict',
            navDirectoryColor: s.view === 'directory' ? '#0b0b0c' : '#c9c9cd', navDirectoryBg: s.view === 'directory' ? '#f2f1ee' : 'transparent',
            navPredictColor: s.view === 'predict' ? '#0b0b0c' : '#c9c9cd', navPredictBg: s.view === 'predict' ? '#f2f1ee' : 'transparent',
            navSearchInput: s.navSearchInput, onNavSearchChange: this.onNavSearchChange, onNavSearchKeyDown: this.onNavSearchKeyDown, onNavSearchSubmit: this.onNavSearchSubmit,
            goToDirectory: this.goToDirectory, goToPredict: this.goToPredict,

            healthBannerVisible: s.healthStatus === 'unreachable',
            healthBannerText: 'Backend unreachable at ' + API_BASE_URL + ' — start it with `uvicorn api.app:app --port 8000` and retry.',
            retryHealth: this.checkHealth,

            directoryCount: filteredPlayers.length, directorySeasonLabel: seasonLabel(s.directorySeason),
            directoryLastUpdatedText: this._lastUpdatedText(s.directoryLastUpdated),
            directoryRefreshing: s.directoryRefreshing, notDirectoryRefreshing: !s.directoryRefreshing,
            directoryRefreshLabel: s.directoryRefreshing || s.detailRefreshing ? 'Refreshing…' : 'Refresh Data',
            refreshDirectory: this.refreshDirectory,
            directorySeason: s.directorySeason, onDirectorySeasonChange: this.onDirectorySeasonChange, seasonOptions,
            positionOptions,
            dirSearchInput: s.dirSearchInput, onDirSearchChange: this.onDirSearchChange, onDirSearchKeyDown: this.onDirSearchKeyDown,
            hasDirSearch: !!s.dirSearchInput, clearDirSearch: this.clearDirSearch,
            directoryLoading: s.directoryLoading, skeletonRows: [1, 2, 3, 4, 5, 6, 7, 8],
            directoryError: s.directoryError, showDirectoryError: !s.directoryLoading && !!s.directoryError, retryDirectory: this.retryDirectory,
            showDirectoryEmpty: !s.directoryLoading && !s.directoryError && filteredPlayers.length === 0 && s.players.length === 0,
            showDirectoryNoMatch: !s.directoryLoading && !s.directoryError && filteredPlayers.length === 0 && s.players.length > 0,
            showDirectoryTable: !s.directoryLoading && !s.directoryError && filteredPlayers.length > 0,
            isMobile: s.isMobile, isDesktopTable: !s.isMobile,
            columns, colTemplate, colTemplateVal: colTemplate, tableRows,

            detailLoading: s.detailLoading, showDetailContent, showDetailError, detailError: s.detailError, retryDetail: this.retryDetail,
            showDetailNoSeason, detailNoSeasonName: s.detailPlayerName, detailSeasonLabel,
            detail, detailSeason: s.detailSeason, onDetailSeasonChange: this.onDetailSeasonChange,
            detailLastUpdatedText: this._lastUpdatedText(s.detailLastUpdated), detailRefreshing: s.detailRefreshing, refreshDetail: this.refreshDetail,

            notFoundName: s.notFoundName,

            form: s.form, formErrors: s.formErrors, formBorder,
            onFormChange_goals: (e) => this.onFieldChange('goals', e),
            onFormChange_assists: (e) => this.onFieldChange('assists', e),
            onFormChange_age: (e) => this.onFieldChange('age', e),
            onFormChange_minutes_played: (e) => this.onFieldChange('minutes_played', e),
            onFormChange_position_group: (e) => this.onFieldChange('position_group', e),
            onFormChange_minutes_share: (e) => this.onFieldChange('minutes_share', e),
            submitPredict: this.submitPredict, predictLoading: s.predictLoading,
            predictButtonLabel: s.predictLoading ? 'Predicting…' : 'Predict Value',
            predictError: s.predictError, predictResult: s.predictResult,
            predictHasResult: s.predictResult != null,
            predictResultFmt: s.predictResult != null ? formatMoney(s.predictResult) : ''
          };
        }
      }
