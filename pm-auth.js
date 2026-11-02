/* ===========================================================================
   PMAuth  -  one Partners Mortgage login + cloud save for every company tool
   ---------------------------------------------------------------------------
   Drop into any tool with ONE line (host this file once, e.g. GitHub Pages):
     <script src="https://partnersmortgage88.github.io/pm-auth/pm-auth.js"></script>

   Then:
     PMAuth.init({
       app: 'social-studio',          // a short id per tool: loan-lens, realtor-radar...
       requireLogin: true,            // show the sign-in screen until they log in
       onReady: function(user){ ... } // runs on every sign-in (user.email, user.name, user.uid)
     });

   Save and load (per person, per tool):
     PMAuth.save('library', dataObject)        -> Promise
     PMAuth.load('library')                    -> Promise(data or null)
     PMAuth.list()                             -> Promise([{ key, data, updatedAt }])
     PMAuth.remove('library')                  -> Promise
   Shared profile (follows the person into EVERY tool):
     PMAuth.getProfile() / PMAuth.saveProfile({ title, nmls, phone, ... })
   Files and images (headshots, generated posts):
     PMAuth.uploadDataUrl('posts/abc.png', dataUrl)  -> Promise(download URL)
   Team-wide data everyone can read (templates, announcements):
     PMAuth.loadShared('templates') / PMAuth.saveShared('templates', data)  (admins only for save)
   Other:
     PMAuth.user(), PMAuth.signOut(), PMAuth.onChange(fn), PMAuth.openLogin()

   Rules: only verified @partnersmortgage.com emails can read or write anything.
   That is enforced by the Firestore and Storage security rules (see SETUP),
   so the apiKey below being visible is normal and safe for Firebase.
   =========================================================================== */
var PMAuth = (function(){

  // ---- 1. Paste your Firebase web app config here (Project settings > Your apps) ----
  var FIREBASE_CONFIG = {
    apiKey: 'AIzaSyCgKNa6AGlw0DiftPf4oK8v-J2Qst_dEwE',
    authDomain: 'partners-platform-348b7.firebaseapp.com',
    projectId: 'partners-platform-348b7',
    storageBucket: 'partners-platform-348b7.firebasestorage.app',
    messagingSenderId: '290374501015',
    appId: '1:290374501015:web:25b81eea5392124ae7dfd2'
  };
  var ALLOWED_DOMAIN = 'partnersmortgage.com';
  var SDK_VERSION = '10.14.1';

  var fb = null, auth = null, db = null, storage = null;
  var current = null, appId = 'tool', opts = {}, listeners = [], readyPromise = null;

  // ---------------------------------------------------------------- loading
  function loadScript(src){
    return new Promise(function(res, rej){
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = res; s.onerror = function(){ rej(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadSdk(){
    if(window.firebase && window.firebase.auth && window.firebase.firestore) return Promise.resolve();
    var base = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
    return loadScript(base + 'firebase-app-compat.js')
      .then(function(){ return loadScript(base + 'firebase-auth-compat.js'); })
      .then(function(){ return loadScript(base + 'firebase-firestore-compat.js'); })
      .then(function(){ return loadScript(base + 'firebase-storage-compat.js'); });
  }

  function emailOk(email){
    return String(email || '').toLowerCase().slice(-(ALLOWED_DOMAIN.length + 1)) === '@' + ALLOWED_DOMAIN;
  }

  function shape(u){
    if(!u) return null;
    return { uid: u.uid, email: u.email, name: u.displayName || String(u.email || '').split('@')[0], verified: !!u.emailVerified };
  }

  // ---------------------------------------------------------------- init
  function init(o){
    opts = o || {};
    appId = String(opts.app || 'tool').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
    injectStyles();
    readyPromise = loadSdk().then(function(){
      fb = window.firebase;
      if(!fb.apps.length) fb.initializeApp(FIREBASE_CONFIG);
      auth = fb.auth();
      db = fb.firestore();
      try { storage = fb.storage(); } catch(e){ storage = null; }
      auth.onAuthStateChanged(function(u){
        if(u && emailOk(u.email) && u.emailVerified){
          current = shape(u);
          closeLogin();
          db.collection('users').doc(u.uid).set({ email: u.email, name: current.name, lastSeen: fb.firestore.FieldValue.serverTimestamp(), lastApp: appId }, { merge: true }).catch(function(){});
          if(typeof opts.onReady === 'function'){ try { opts.onReady(current); } catch(e){ console.error(e); } }
        } else {
          current = null;
          if(u && emailOk(u.email) && !u.emailVerified) showLogin('verify', u.email);
          else if(opts.requireLogin) showLogin('signin');
        }
        for(var i = 0; i < listeners.length; i++){ try { listeners[i](current); } catch(e){} }
      });
    }).catch(function(err){
      console.error('PMAuth failed to start', err);
      showLogin('error', String(err.message || err));
    });
    return readyPromise;
  }

  function need(){
    if(!current) return Promise.reject(new Error('Not signed in'));
    return readyPromise;
  }
  function itemRef(key){ return db.collection('users').doc(current.uid).collection('apps').doc(appId).collection('items').doc(String(key)); }

  // ---------------------------------------------------------------- data API
  function save(key, data){
    return need().then(function(){
      return itemRef(key).set({ data: data, updatedAt: fb.firestore.FieldValue.serverTimestamp() });
    });
  }
  function load(key){
    return need().then(function(){ return itemRef(key).get(); }).then(function(d){ return d.exists ? d.data().data : null; });
  }
  function list(){
    return need().then(function(){
      return db.collection('users').doc(current.uid).collection('apps').doc(appId).collection('items').orderBy('updatedAt', 'desc').get();
    }).then(function(snap){
      var out = [];
      snap.forEach(function(d){ var v = d.data(); out.push({ key: d.id, data: v.data, updatedAt: v.updatedAt ? v.updatedAt.toDate() : null }); });
      return out;
    });
  }
  function remove(key){ return need().then(function(){ return itemRef(key).delete(); }); }

  function getProfile(){
    return need().then(function(){ return db.collection('users').doc(current.uid).get(); })
      .then(function(d){ return d.exists ? (d.data().profile || {}) : {}; });
  }
  function saveProfile(p){
    return need().then(function(){ return db.collection('users').doc(current.uid).set({ profile: p || {} }, { merge: true }); });
  }

  function loadShared(key){
    return need().then(function(){ return db.collection('shared').doc(appId + '__' + key).get(); })
      .then(function(d){ return d.exists ? d.data().data : null; });
  }
  function saveShared(key, data){
    return need().then(function(){
      return db.collection('shared').doc(appId + '__' + key).set({ data: data, updatedAt: fb.firestore.FieldValue.serverTimestamp(), by: current.email });
    });
  }

  function uploadDataUrl(path, dataUrl){
    return need().then(function(){
      if(!storage) throw new Error('File storage is not enabled for this project');
      var ref = storage.ref('users/' + current.uid + '/' + appId + '/' + String(path).replace(/^\/+/, ''));
      return ref.putString(dataUrl, 'data_url').then(function(){ return ref.getDownloadURL(); });
    });
  }

  function signOut(){ return auth ? auth.signOut() : Promise.resolve(); }
  function onChange(fn){ listeners.push(fn); if(current) fn(current); }
  function user(){ return current; }

  // ---------------------------------------------------------------- login UI
  var overlay = null;
  function injectStyles(){
    if(document.getElementById('pmauth-css')) return;
    var css = '' +
      '#pmauth{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;' +
      'background:radial-gradient(900px 500px at 85% -10%,rgba(37,186,196,.22),transparent 60%),radial-gradient(700px 400px at 0% 110%,rgba(255,172,39,.10),transparent 60%),rgba(4,10,12,.94);' +
      'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",system-ui,sans-serif;color:#F5F5F7}' +
      '#pmauth .pa-card{width:400px;max-width:100%;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015)),#0F181A;border-radius:24px;padding:30px 28px 24px;box-shadow:0 0 0 1px rgba(255,255,255,.09),0 40px 100px rgba(0,0,0,.6)}' +
      '#pmauth .pa-logo{display:flex;align-items:center;gap:10px;margin-bottom:22px}' +
      '#pmauth .pa-mark{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#00818D,#25BAC4);display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:17px}' +
      '#pmauth .pa-brand b{display:block;font-size:15px;letter-spacing:-.01em}#pmauth .pa-brand span{font-size:12px;color:#86868B}' +
      '#pmauth h2{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px}' +
      '#pmauth p{font-size:14px;color:#A1A1A6;line-height:1.5;margin:0 0 18px}' +
      '#pmauth label{display:block;font-size:12.5px;font-weight:600;color:#D1D1D6;margin:12px 0 6px}' +
      '#pmauth input{width:100%;box-sizing:border-box;background:#0A1214;border:1px solid rgba(255,255,255,.16);border-radius:12px;color:#F5F5F7;font-size:15px;padding:12px 14px;outline:none;font-family:inherit}' +
      '#pmauth input:focus{border-color:#25BAC4;box-shadow:0 0 0 4px rgba(37,186,196,.18)}' +
      '#pmauth .pa-go{width:100%;margin-top:18px;border:none;border-radius:14px;padding:14px;font-size:15.5px;font-weight:600;color:#fff;cursor:pointer;font-family:inherit;background:linear-gradient(180deg,#0896A2,#00818D);box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}' +
      '#pmauth .pa-go:disabled{opacity:.6;cursor:wait}' +
      '#pmauth .pa-links{display:flex;justify-content:space-between;margin-top:16px;font-size:13px}' +
      '#pmauth .pa-links a{color:#3CC5CE;text-decoration:none;cursor:pointer}' +
      '#pmauth .pa-msg{margin-top:14px;font-size:13px;line-height:1.45;border-radius:10px;padding:10px 12px;display:none}' +
      '#pmauth .pa-msg.err{display:block;background:rgba(255,69,58,.10);color:#FF8A80;box-shadow:0 0 0 1px rgba(255,69,58,.3)}' +
      '#pmauth .pa-msg.ok{display:block;background:rgba(48,209,88,.10);color:#7EE29A;box-shadow:0 0 0 1px rgba(48,209,88,.3)}' +
      '#pmauth .pa-foot{margin-top:18px;font-size:11.5px;color:#6E6E73;text-align:center}' +
      '.pmauth-chip{position:fixed;right:14px;bottom:14px;z-index:2147482000;display:flex;align-items:center;gap:8px;background:rgba(15,24,26,.92);color:#D1D1D6;font:500 12.5px -apple-system,BlinkMacSystemFont,"Inter",sans-serif;padding:7px 8px 7px 12px;border-radius:999px;box-shadow:0 0 0 1px rgba(255,255,255,.1),0 8px 24px rgba(0,0,0,.4)}' +
      '.pmauth-chip button{background:rgba(255,255,255,.08);color:#F5F5F7;border:none;border-radius:999px;padding:4px 10px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer}';
    var st = document.createElement('style');
    st.id = 'pmauth-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }

  function showLogin(mode, extra){
    if(!overlay){
      overlay = document.createElement('div');
      overlay.id = 'pmauth';
      document.body.appendChild(overlay);
    }
    var tool = opts.toolName || 'Partners tools';
    var head = '<div class="pa-card"><div class="pa-logo"><div class="pa-mark">P</div><div class="pa-brand"><b>Partners Mortgage</b><span>' + esc(tool) + '</span></div></div>';
    var foot = '<div class="pa-foot">One account for every Partners tool. Use your @' + ALLOWED_DOMAIN + ' email.</div></div>';
    var h = '';
    if(mode === 'signup'){
      h = '<h2>Create your account</h2><p>Use your work email. We will send a link to confirm it is you.</p>' +
        '<label>Full name</label><input id="paName" autocomplete="name" placeholder="First Last">' +
        '<label>Work email</label><input id="paEmail" type="email" autocomplete="email" placeholder="you@' + ALLOWED_DOMAIN + '">' +
        '<label>Password</label><input id="paPw" type="password" autocomplete="new-password" placeholder="At least 8 characters">' +
        '<button class="pa-go" id="paGo">Create account</button><div class="pa-msg" id="paMsg"></div>' +
        '<div class="pa-links"><a data-go="signin">I already have an account</a></div>';
    } else if(mode === 'reset'){
      h = '<h2>Reset your password</h2><p>Enter your work email and we will send you a reset link.</p>' +
        '<label>Work email</label><input id="paEmail" type="email" autocomplete="email" placeholder="you@' + ALLOWED_DOMAIN + '">' +
        '<button class="pa-go" id="paGo">Send reset link</button><div class="pa-msg" id="paMsg"></div>' +
        '<div class="pa-links"><a data-go="signin">Back to sign in</a></div>';
    } else if(mode === 'verify'){
      h = '<h2>Check your inbox</h2><p>We sent a confirmation link to <b>' + esc(extra || '') + '</b>. Click it, then come back and press continue.</p>' +
        '<button class="pa-go" id="paGo">I clicked the link, continue</button><div class="pa-msg" id="paMsg"></div>' +
        '<div class="pa-links"><a data-go="resend">Resend the email</a><a data-go="signout">Use a different email</a></div>';
    } else if(mode === 'error'){
      h = '<h2>Could not connect</h2><p>The sign-in service did not load. Check your connection and refresh the page.</p><p style="font-size:12px;color:#6E6E73">' + esc(extra || '') + '</p>';
    } else {
      h = '<h2>Sign in</h2><p>Your work saves to your account, so it is there on any computer.</p>' +
        '<label>Work email</label><input id="paEmail" type="email" autocomplete="email" placeholder="you@' + ALLOWED_DOMAIN + '">' +
        '<label>Password</label><input id="paPw" type="password" autocomplete="current-password" placeholder="Password">' +
        '<button class="pa-go" id="paGo">Sign in</button><div class="pa-msg" id="paMsg"></div>' +
        '<div class="pa-links"><a data-go="signup">Create an account</a><a data-go="reset">Forgot password?</a></div>';
    }
    overlay.innerHTML = head + h + foot;
    overlay.style.display = 'flex';
    var links = overlay.querySelectorAll('[data-go]');
    for(var i = 0; i < links.length; i++){
      links[i].addEventListener('click', function(e){
        var g = e.currentTarget.getAttribute('data-go');
        if(g === 'resend'){ resend(); return; }
        if(g === 'signout'){ signOut().then(function(){ showLogin('signin'); }); return; }
        showLogin(g);
      });
    }
    var go = document.getElementById('paGo');
    if(go) go.addEventListener('click', function(){ submit(mode); });
    var inputs = overlay.querySelectorAll('input');
    for(var j = 0; j < inputs.length; j++) inputs[j].addEventListener('keydown', function(e){ if(e.key === 'Enter') submit(mode); });
    var first = overlay.querySelector('input');
    if(first) setTimeout(function(){ first.focus(); }, 50);
  }

  function closeLogin(){ if(overlay) overlay.style.display = 'none'; }

  function msg(t, ok){
    var m = document.getElementById('paMsg');
    if(!m) return;
    m.className = 'pa-msg ' + (ok ? 'ok' : 'err');
    m.textContent = t;
  }
  function busy(on, label){
    var b = document.getElementById('paGo');
    if(!b) return;
    if(on){ b.setAttribute('data-l', b.textContent); b.textContent = label || 'One moment...'; b.disabled = true; }
    else { b.textContent = b.getAttribute('data-l') || b.textContent; b.disabled = false; }
  }
  function friendly(err){
    var c = (err && err.code) || '';
    if(c.indexOf('wrong-password') > -1 || c.indexOf('invalid-credential') > -1 || c.indexOf('invalid-login') > -1) return 'That email and password do not match.';
    if(c.indexOf('user-not-found') > -1) return 'No account with that email yet. Create one below.';
    if(c.indexOf('email-already-in-use') > -1) return 'That email already has an account. Sign in instead.';
    if(c.indexOf('weak-password') > -1) return 'Use a longer password, at least 8 characters.';
    if(c.indexOf('too-many-requests') > -1) return 'Too many tries. Wait a minute and try again.';
    if(c.indexOf('unauthorized-domain') > -1) return 'This website is not on the approved list yet. Ask the admin to add it in Firebase.';
    if(c.indexOf('network') > -1) return 'Connection problem. Check your internet and try again.';
    return (err && err.message) || 'Something went wrong. Try again.';
  }

  function val(id){ var el = document.getElementById(id); return el ? el.value.trim() : ''; }

  function submit(mode){
    if(!auth){ msg('Still connecting. Try again in a second.'); return; }
    var email = val('paEmail').toLowerCase(), pw = val('paPw');
    if(mode === 'verify'){
      var u = auth.currentUser;
      if(!u){ showLogin('signin'); return; }
      busy(true, 'Checking...');
      u.reload().then(function(){
        busy(false);
        if(auth.currentUser.emailVerified){
          return auth.currentUser.getIdToken(true).then(function(){ window.location.reload(); });
        }
        msg('Not confirmed yet. Click the link in the email, then press continue.');
      }).catch(function(e){ busy(false); msg(friendly(e)); });
      return;
    }
    if(mode !== 'verify' && !emailOk(email)){ msg('Use your @' + ALLOWED_DOMAIN + ' work email.'); return; }
    if(mode === 'reset'){
      busy(true, 'Sending...');
      auth.sendPasswordResetEmail(email).then(function(){ busy(false); msg('Reset link sent. Check your inbox.', true); })
        .catch(function(e){ busy(false); msg(friendly(e)); });
      return;
    }
    if(!pw){ msg('Enter your password.'); return; }
    if(mode === 'signup'){
      var name = val('paName');
      if(!name){ msg('Enter your name.'); return; }
      if(pw.length < 8){ msg('Use at least 8 characters for your password.'); return; }
      busy(true, 'Creating your account...');
      auth.createUserWithEmailAndPassword(email, pw).then(function(cred){
        return cred.user.updateProfile({ displayName: name }).then(function(){ return cred.user.sendEmailVerification(); });
      }).then(function(){ busy(false); showLogin('verify', email); })
        .catch(function(e){ busy(false); msg(friendly(e)); });
      return;
    }
    busy(true, 'Signing in...');
    auth.signInWithEmailAndPassword(email, pw).then(function(){ busy(false); })
      .catch(function(e){ busy(false); msg(friendly(e)); });
  }

  function resend(){
    var u = auth && auth.currentUser;
    if(!u) return;
    u.sendEmailVerification().then(function(){ msg('Sent again. Check your inbox and spam folder.', true); })
      .catch(function(e){ msg(friendly(e)); });
  }

  // Small signed-in chip with sign-out (tools can hide it with opts.chip === false)
  onChange(function(u){
    var chip = document.getElementById('pmauthChip');
    if(!u || opts.chip === false){ if(chip) chip.remove(); return; }
    if(!chip){ chip = document.createElement('div'); chip.id = 'pmauthChip'; chip.className = 'pmauth-chip'; document.body.appendChild(chip); }
    chip.innerHTML = '<span>' + esc(u.email) + '</span><button type="button">Sign out</button>';
    chip.querySelector('button').onclick = function(){ signOut().then(function(){ if(opts.requireLogin) showLogin('signin'); }); };
  });

  return {
    init: init, user: user, onChange: onChange, signOut: signOut, openLogin: function(){ showLogin('signin'); },
    save: save, load: load, list: list, remove: remove,
    getProfile: getProfile, saveProfile: saveProfile,
    loadShared: loadShared, saveShared: saveShared,
    uploadDataUrl: uploadDataUrl,
    ready: function(){ return readyPromise; }
  };
})();
