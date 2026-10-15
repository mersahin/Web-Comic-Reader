/*
 * Google Analytics 4, only after the visitor allows it in the consent banner (EU rules: no
 * analytics cookie without consent). Without a Measurement ID in analytics-config.js nothing
 * happens at all.
 *
 * Sent: page views of this page (its address without query or hash, where email links carry
 * tokens) and a few anonymous events: open_comic (with its source: upload, folder or telegram),
 * login, sign_up and telegram_search. Never file names, search text, email addresses or other
 * account data. Google signals and ad personalisation are off.
 */
document.addEventListener('DOMContentLoaded', () => {
    const config = window.COMIC_ANALYTICS_CONFIG || {};
    const id = typeof config.measurementId === 'string' ? config.measurementId.trim() : '';
    const banner = document.getElementById('analyticsBanner');
    const acceptBtn = document.getElementById('analyticsAcceptBtn');
    const declineBtn = document.getElementById('analyticsDeclineBtn');
    const settingsBtn = document.getElementById('analyticsSettingsBtn');
    const CONSENT_KEY = 'comic_analytics_consent';
    const ALLOWED_PARAMS = ['source', 'method'];

    // callers use this whether or not analytics is set up
    window.ComicAnalytics = { event() {} };
    if (!/^G-[A-Z0-9]{4,}$/.test(id) || !banner || !acceptBtn || !declineBtn) return;

    let loaded = false;

    function readConsent() {
        try {
            return localStorage.getItem(CONSENT_KEY);
        } catch (e) {
            return null;
        }
    }

    function writeConsent(value) {
        try {
            localStorage.setItem(CONSENT_KEY, value);
        } catch (e) {
            // storage unavailable: the banner asks again next time
        }
    }

    const granted = () => readConsent() === 'granted';
    const pageLocation = () => window.location.origin + window.location.pathname;

    window.dataLayer = window.dataLayer || [];
    function gtag() {
        window.dataLayer.push(arguments);
    }

    function start() {
        window[`ga-disable-${id}`] = false;
        if (loaded) {
            gtag('consent', 'update', { analytics_storage: 'granted' });
            return;
        }
        loaded = true;
        gtag('consent', 'default', {
            analytics_storage: 'granted',
            ad_storage: 'denied',
            ad_user_data: 'denied',
            ad_personalization: 'denied'
        });
        gtag('js', new Date());
        gtag('config', id, {
            page_location: pageLocation(),
            page_title: document.title,
            allow_google_signals: false,
            allow_ad_personalization_signals: false
        });
        const script = document.createElement('script');
        script.async = true;
        script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
        document.head.appendChild(script);
    }

    // a later "Decline": GA's own opt-out flag stops all sending, and its cookies go
    function stop() {
        window[`ga-disable-${id}`] = true;
        if (loaded) gtag('consent', 'update', { analytics_storage: 'denied' });
        const names = document.cookie.split(';')
            .map((part) => part.split('=')[0].trim())
            .filter((name) => name === '_ga' || name.startsWith('_ga_'));
        names.forEach((name) => {
            // host cookie and the domain cookie GA sets on this host (github.io is a public suffix)
            [`; domain=${window.location.hostname}`, ''].forEach((domain) => {
                document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
            });
        });
    }

    function showBanner(on) {
        banner.hidden = !on;
    }

    function choose(value) {
        writeConsent(value);
        showBanner(false);
        if (value === 'granted') start();
        else stop();
        if (settingsBtn) settingsBtn.focus();
    }

    acceptBtn.addEventListener('click', () => choose('granted'));
    declineBtn.addEventListener('click', () => choose('denied'));
    if (settingsBtn) {
        settingsBtn.hidden = false;
        settingsBtn.addEventListener('click', () => {
            showBanner(true);
            (granted() ? declineBtn : acceptBtn).focus();
        });
    }

    window.ComicAnalytics = {
        // only known, non-personal parameters are passed on
        event(name, params = {}) {
            if (!loaded || !granted()) return;
            const safe = {};
            ALLOWED_PARAMS.forEach((key) => {
                if (typeof params[key] === 'string') safe[key] = params[key];
            });
            gtag('event', name, safe);
        }
    };

    document.addEventListener('comicreader:reader-opened', (event) => {
        const source = event.detail && event.detail.source;
        window.ComicAnalytics.event('open_comic', { source: ['upload', 'folder', 'telegram'].includes(source) ? source : 'other' });
    });

    const consent = readConsent();
    if (consent === 'granted') start();
    else if (consent !== 'denied') showBanner(true);
});
