package app.driftshare.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Direct phone-to-phone transfers on the same Wi-Fi, with no PC.
 *
 * Each phone runs a tiny HTTP server and announces itself with mDNS
 * (service type _driftshare._tcp). Sending files is a two-step handshake:
 *   1. POST /offer   - "I want to send you these files". The receiver's screen
 *                      asks the person to Accept or Decline; the request waits.
 *   2. POST /file    - one request per file, carrying a one-time token from step 1.
 * Short text messages go straight through POST /message.
 */
@CapacitorPlugin(
    name = "Direct",
    permissions = {
        @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "storage")
    }
)
public class DirectPlugin extends Plugin {

    private static final String TAG = "DriftDirect";
    private static final String SERVICE_TYPE = "_driftshare._tcp.";
    private static final int PREFERRED_PORT = 47821;
    private static final long OFFER_TIMEOUT_SEC = 90;
    private static final SecureRandom RANDOM = new SecureRandom();

    private String myId;
    private String myName;
    private ServerSocket server;
    private int port;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    private NsdManager nsd;
    private NsdManager.RegistrationListener regListener;
    private NsdManager.DiscoveryListener discListener;
    private WifiManager.MulticastLock multicastLock;
    private final LinkedList<NsdServiceInfo> resolveQueue = new LinkedList<>();
    private boolean resolving = false;

    /** id -> peer {id, name, host, port, service} */
    private final Map<String, JSObject> peers = new ConcurrentHashMap<>();
    /** mDNS service name -> peer id, so we can drop peers that go away */
    private final Map<String, String> serviceToPeer = new ConcurrentHashMap<>();

    /** Incoming offers waiting for Accept/Decline. */
    private final Map<String, Offer> offers = new ConcurrentHashMap<>();
    /** Accepted offers: token -> offer. */
    private final Map<String, Offer> accepted = new ConcurrentHashMap<>();

    private static class Offer {
        String id;
        String token;
        String fromId;
        String fromName;
        JSONArray files;
        String folder;
        long totalSize;
        int received;
        volatile Boolean decision;
        final CountDownLatch latch = new CountDownLatch(1);
    }

    // ------------------------------------------------------------------ shared from other apps

    /** Files (or text) handed to Driftshare from another app's Share menu, waiting for a destination. */
    private static final List<Uri> sharedUris = new ArrayList<>();
    private static String sharedText;

    static synchronized void setShared(List<Uri> uris, String text) {
        sharedUris.clear();
        sharedUris.addAll(uris);
        sharedText = text;
    }

    private static synchronized List<Uri> takeSharedUris() {
        return new ArrayList<>(sharedUris);
    }

    @PluginMethod
    public void getShared(PluginCall call) {
        List<Uri> uris = takeSharedUris();
        String text;
        synchronized (DirectPlugin.class) { text = sharedText; }
        pool.execute(() -> {
            try {
                JSObject r = new JSObject();
                r.put("files", new JSArray(describe(uris).toString()));
                if (text != null) r.put("text", text);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Couldn't read the shared files: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void clearShared(PluginCall call) {
        setShared(new ArrayList<>(), null);
        call.resolve();
    }

    /** Send what was shared to a nearby phone (same handshake as picking files in the app). */
    @PluginMethod
    public void sendShared(PluginCall call) {
        JSObject peer = peers.get(call.getString("peerId", ""));
        if (peer == null) { call.reject("That phone is no longer nearby"); return; }
        List<Uri> uris = takeSharedUris();
        if (uris.isEmpty()) { call.reject("Nothing to send"); return; }
        String transferId = call.getString("transferId", randomToken(6));
        pool.execute(() -> sendUris(call, peer, uris, null, null, transferId));
    }

    /**
     * Send what was shared straight to a Driftshare PC, using the PC's normal upload API,
     * so it shows up in this phone's chat on the PC. Several files go as one batch.
     */
    @PluginMethod
    public void sendSharedToPc(PluginCall call) {
        String addr = call.getString("addr", "");
        String code = call.getString("code", "");
        if (!addr.matches("[A-Za-z0-9.:\\[\\]-]{3,80}")) { call.reject("Bad PC address"); return; }
        List<Uri> uris = takeSharedUris();
        String text;
        synchronized (DirectPlugin.class) { text = sharedText; }
        String transferId = call.getString("transferId", randomToken(6));
        pool.execute(() -> {
            ContentResolver cr = getContext().getContentResolver();
            String base = "http://" + addr;
            String auth = "k=" + enc(code) + "&d=" + enc(myId);
            try {
                // Say hello first so the PC knows this phone's name.
                Resp hello = get(base + "/api/hello?" + auth + "&name=" + enc(myName) + "&platform=android");
                if (hello.code == 401) { call.reject("The PC's pairing code changed. Connect to the PC again under My PC."); return; }
                if (hello.code != 200) { call.reject("The PC answered " + hello.code); return; }

                if (uris.isEmpty() && text != null) {
                    JSONObject body = new JSONObject();
                    body.put("text", text);
                    Resp r = postJsonUrl(base + "/api/message?" + auth, body);
                    if (r.code != 200) throw new IOException("The PC refused the message (" + r.code + ")");
                    call.resolve();
                    return;
                }

                JSONArray files = describe(uris);
                long total = 0;
                for (int i = 0; i < files.length(); i++) total += Math.max(0, files.getJSONObject(i).optLong("size", 0));
                JSObject started = new JSObject();
                started.put("transferId", transferId);
                started.put("peerId", "pc");
                started.put("files", files);
                started.put("totalSize", total);
                notifyListeners("sendStarted", started);

                String batch = uris.size() > 1 ? "and" + randomToken(6) : null;
                long sent = 0;
                byte[] buf = new byte[64 * 1024];
                for (int i = 0; i < uris.size(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    String q = auth + "&to=hub&name=" + enc(f.optString("name", "file")) + (batch != null ? "&batch=" + batch : "");
                    HttpURLConnection conn = (HttpURLConnection) new URL(base + "/api/upload?" + q).openConnection();
                    conn.setConnectTimeout(8000);
                    conn.setReadTimeout(60000);
                    conn.setDoOutput(true);
                    conn.setRequestMethod("POST");
                    long size = f.optLong("size", -1);
                    if (size >= 0) conn.setFixedLengthStreamingMode(size); else conn.setChunkedStreamingMode(64 * 1024);
                    try (InputStream in = cr.openInputStream(uris.get(i)); OutputStream out = conn.getOutputStream()) {
                        if (in == null) throw new IOException("Can't read " + f.optString("name"));
                        int n;
                        long lastEmit = 0;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            sent += n;
                            long now = System.currentTimeMillis();
                            if (now - lastEmit > 250) { emitSend(transferId, "sending", sent, total, f.optString("name")); lastEmit = now; }
                        }
                    }
                    int rc = conn.getResponseCode();
                    conn.disconnect();
                    if (rc != 200) throw new IOException("The PC stopped the transfer (" + rc + ")");
                }
                if (batch != null) {
                    JSONObject body = new JSONObject();
                    body.put("batch", batch);
                    postJsonUrl(base + "/api/batch-done?" + auth, body);
                }
                emitSend(transferId, "done", sent, total, null);
                JSObject r = new JSObject();
                r.put("accepted", true);
                call.resolve(r);
            } catch (Exception e) {
                Log.w(TAG, "send to PC failed", e);
                emitSend(transferId, "failed", 0, 0, e.getMessage());
                call.reject("Couldn't send to the PC: " + e.getMessage());
            }
        });
    }

    /** Name and size of each content Uri, as the JSON the transfer code uses. */
    private JSONArray describe(List<Uri> uris) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        JSONArray files = new JSONArray();
        for (Uri u : uris) {
            String name = u.getLastPathSegment() != null ? u.getLastPathSegment() : "file";
            long size = -1;
            try (Cursor c = cr.query(u, null, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int si = c.getColumnIndex(OpenableColumns.SIZE);
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
                }
            } catch (Exception ignored) {
                // Some providers don't answer queries; the name and size stay as guesses.
            }
            JSONObject f = new JSONObject();
            f.put("name", safeName(name));
            f.put("size", size);
            f.put("type", cr.getType(u) == null ? "" : cr.getType(u));
            files.put(f);
        }
        return files;
    }

    private Resp get(String url) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(6000);
        conn.setReadTimeout(15000);
        Resp r = new Resp();
        r.code = conn.getResponseCode();
        InputStream in = r.code < 400 ? conn.getInputStream() : conn.getErrorStream();
        r.body = in == null ? "" : readAll(in, 1 << 16);
        conn.disconnect();
        return r;
    }

    private Resp postJsonUrl(String url, JSONObject body) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(6000);
        conn.setReadTimeout(30000);
        conn.setDoOutput(true);
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = conn.getOutputStream()) { out.write(bytes); }
        Resp r = new Resp();
        r.code = conn.getResponseCode();
        InputStream in = r.code < 400 ? conn.getInputStream() : conn.getErrorStream();
        r.body = in == null ? "" : readAll(in, 1 << 16);
        conn.disconnect();
        return r;
    }

    // ------------------------------------------------------------------ lifecycle

    @PluginMethod
    public void start(PluginCall call) {
        myId = call.getString("id");
        myName = call.getString("name", Build.MODEL);
        if (myId == null || !myId.matches("[A-Za-z0-9_-]{6,64}")) {
            call.reject("Missing device id");
            return;
        }
        try {
            if (server == null) startServer();
            startNsd();
            JSObject r = new JSObject();
            r.put("port", port);
            r.put("peers", peerArray());
            call.resolve(r);
        } catch (Exception e) {
            Log.e(TAG, "start failed", e);
            call.reject("Could not start: " + e.getMessage());
        }
    }

    @PluginMethod
    public void rename(PluginCall call) {
        String n = call.getString("name");
        if (n != null && !n.trim().isEmpty()) {
            myName = n.trim();
            stopNsd();
            startNsd();
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        shutdown();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        shutdown();
    }

    private void shutdown() {
        stopNsd();
        if (server != null) {
            try { server.close(); } catch (IOException ignored) {}
            server = null;
        }
        for (Offer o : offers.values()) { o.decision = false; o.latch.countDown(); }
        offers.clear();
    }

    @PluginMethod
    public void getPeers(PluginCall call) {
        JSObject r = new JSObject();
        r.put("peers", peerArray());
        call.resolve(r);
    }

    private JSArray peerArray() {
        JSArray a = new JSArray();
        for (JSObject p : peers.values()) {
            JSObject copy = new JSObject();
            copy.put("id", p.optString("id"));
            copy.put("name", p.optString("name"));
            a.put(copy);
        }
        return a;
    }

    // ------------------------------------------------------------------ discovery (mDNS)

    private void startNsd() {
        Context ctx = getContext();
        nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
        WifiManager wifi = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi != null && multicastLock == null) {
            multicastLock = wifi.createMulticastLock("driftshare");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        }

        NsdServiceInfo info = new NsdServiceInfo();
        // Service names must be unique on the network; the id suffix guarantees that.
        String label = myName.replaceAll("[^A-Za-z0-9 _-]", "").trim();
        if (label.isEmpty()) label = "Phone";
        if (label.length() > 40) label = label.substring(0, 40);
        info.setServiceName(label + " #" + myId.substring(0, 6));
        info.setServiceType(SERVICE_TYPE);
        info.setPort(port);
        info.setAttribute("id", myId);
        info.setAttribute("name", myName.length() > 60 ? myName.substring(0, 60) : myName);

        regListener = new NsdManager.RegistrationListener() {
            @Override public void onServiceRegistered(NsdServiceInfo s) { Log.i(TAG, "announced as " + s.getServiceName()); }
            @Override public void onRegistrationFailed(NsdServiceInfo s, int code) { Log.w(TAG, "announce failed " + code); }
            @Override public void onServiceUnregistered(NsdServiceInfo s) {}
            @Override public void onUnregistrationFailed(NsdServiceInfo s, int code) {}
        };
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, regListener);

        discListener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String type) {}
            @Override public void onDiscoveryStopped(String type) {}
            @Override public void onStartDiscoveryFailed(String type, int code) { Log.w(TAG, "discovery failed " + code); }
            @Override public void onStopDiscoveryFailed(String type, int code) {}

            @Override
            public void onServiceFound(NsdServiceInfo s) {
                if (!s.getServiceType().startsWith("_driftshare._tcp")) return;
                if (s.getServiceName().endsWith("#" + myId.substring(0, 6))) return; // that's us
                enqueueResolve(s);
            }

            @Override
            public void onServiceLost(NsdServiceInfo s) {
                String id = serviceToPeer.remove(s.getServiceName());
                if (id != null && peers.remove(id) != null) emitPeers();
            }
        };
        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discListener);
    }

    private void stopNsd() {
        if (nsd == null) return;
        try { if (regListener != null) nsd.unregisterService(regListener); } catch (Exception ignored) {}
        try { if (discListener != null) nsd.stopServiceDiscovery(discListener); } catch (Exception ignored) {}
        regListener = null;
        discListener = null;
        if (multicastLock != null) { try { multicastLock.release(); } catch (Exception ignored) {} multicastLock = null; }
        peers.clear();
        serviceToPeer.clear();
        emitPeers();
    }

    // Older Android versions can only resolve one service at a time.
    private synchronized void enqueueResolve(NsdServiceInfo s) {
        resolveQueue.add(s);
        if (!resolving) resolveNext();
    }

    private synchronized void resolveNext() {
        NsdServiceInfo next = resolveQueue.poll();
        if (next == null || nsd == null) { resolving = false; return; }
        resolving = true;
        nsd.resolveService(next, new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo s, int code) {
                resolveNext();
            }

            @Override
            public void onServiceResolved(NsdServiceInfo s) {
                try {
                    Map<String, byte[]> attrs = s.getAttributes();
                    String id = attrs.get("id") != null ? new String(attrs.get("id"), StandardCharsets.UTF_8) : null;
                    String name = attrs.get("name") != null ? new String(attrs.get("name"), StandardCharsets.UTF_8) : s.getServiceName();
                    InetAddress host = s.getHost();
                    if (id != null && !id.equals(myId) && host != null) {
                        JSObject p = new JSObject();
                        p.put("id", id);
                        p.put("name", name);
                        p.put("host", host.getHostAddress());
                        p.put("port", s.getPort());
                        peers.put(id, p);
                        serviceToPeer.put(s.getServiceName(), id);
                        emitPeers();
                    }
                } finally {
                    resolveNext();
                }
            }
        });
    }

    private void emitPeers() {
        JSObject e = new JSObject();
        e.put("peers", peerArray());
        notifyListeners("peers", e);
    }

    // ------------------------------------------------------------------ sending

    @PluginMethod
    public void sendText(PluginCall call) {
        JSObject peer = peers.get(call.getString("peerId", ""));
        String text = call.getString("text", "");
        if (peer == null) { call.reject("That phone is no longer nearby"); return; }
        if (text.trim().isEmpty()) { call.reject("Empty message"); return; }
        pool.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("from", myId);
                body.put("fromName", myName);
                body.put("text", text);
                int code = postJson(peer, "/message", body, 15000).code;
                if (code == 200) call.resolve(); else call.reject("The other phone refused the message (" + code + ")");
            } catch (Exception e) {
                call.reject("Could not reach that phone: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void sendFiles(PluginCall call) {
        if (peers.get(call.getString("peerId", "")) == null) { call.reject("That phone is no longer nearby"); return; }
        if (Boolean.TRUE.equals(call.getBoolean("folder", false))) {
            startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "onFolderPicked");
            return;
        }
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("*/*");
        pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, pick, "onFilesPicked");
    }

    @ActivityCallback
    private void onFilesPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            JSObject r = new JSObject();
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        JSObject peer = peers.get(call.getString("peerId", ""));
        if (peer == null) { call.reject("That phone is no longer nearby"); return; }
        String transferId = call.getString("transferId", randomToken(6));
        pool.execute(() -> sendUris(call, peer, uris, null, null, transferId));
    }

    private static final int MAX_FOLDER_FILES = 5000;

    @ActivityCallback
    private void onFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject r = new JSObject();
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        JSObject peer = peers.get(call.getString("peerId", ""));
        if (peer == null) { call.reject("That phone is no longer nearby"); return; }
        Uri tree = data.getData();
        String transferId = call.getString("transferId", randomToken(6));
        pool.execute(() -> {
            try {
                ContentResolver cr = getContext().getContentResolver();
                String rootId = DocumentsContract.getTreeDocumentId(tree);
                String rootName = "Folder";
                try (Cursor c = cr.query(DocumentsContract.buildDocumentUriUsingTree(tree, rootId),
                        new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                    if (c != null && c.moveToFirst() && !c.isNull(0)) rootName = c.getString(0);
                }
                List<Uri> uris = new ArrayList<>();
                List<String> paths = new ArrayList<>();
                walkTree(cr, tree, rootId, safeName(rootName), uris, paths);
                if (uris.isEmpty()) { call.reject("That folder is empty"); return; }
                sendUris(call, peer, uris, paths, safeName(rootName), transferId);
            } catch (Exception e) {
                Log.w(TAG, "folder read failed", e);
                call.reject("Couldn't read that folder: " + e.getMessage());
            }
        });
    }

    /** Every file under a picked folder, with its path inside it ("Holiday/Day 2/a.jpg"). */
    private void walkTree(ContentResolver cr, Uri tree, String docId, String prefix, List<Uri> uris, List<String> paths) throws IOException {
        if (uris.size() >= MAX_FOLDER_FILES) throw new IOException("More than " + MAX_FOLDER_FILES + " files");
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        String[] cols = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        List<String[]> dirs = new ArrayList<>();
        try (Cursor c = cr.query(children, cols, null, null, DocumentsContract.Document.COLUMN_DISPLAY_NAME)) {
            while (c != null && c.moveToNext()) {
                String id = c.getString(0);
                String name = c.isNull(1) ? "file" : c.getString(1);
                String mime = c.isNull(2) ? "" : c.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    dirs.add(new String[]{id, name});
                } else {
                    uris.add(DocumentsContract.buildDocumentUriUsingTree(tree, id));
                    paths.add(prefix + "/" + safeName(name));
                    if (uris.size() >= MAX_FOLDER_FILES) throw new IOException("More than " + MAX_FOLDER_FILES + " files");
                }
            }
        }
        for (String[] d : dirs) walkTree(cr, tree, d[0], prefix + "/" + safeName(d[1]), uris, paths);
    }

    private void sendUris(PluginCall call, JSObject peer, List<Uri> uris, List<String> paths, String folder, String transferId) {
        ContentResolver cr = getContext().getContentResolver();
        try {
            JSONArray files = new JSONArray();
            long total = 0;
            for (int k = 0; k < uris.size(); k++) {
                Uri u = uris.get(k);
                String name = "file";
                long size = -1;
                try (Cursor c = cr.query(u, null, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        int si = c.getColumnIndex(OpenableColumns.SIZE);
                        if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                        if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
                    }
                }
                JSONObject f = new JSONObject();
                f.put("name", name);
                f.put("size", size);
                if (paths != null) f.put("path", paths.get(k));
                files.put(f);
                if (size > 0) total += size;
            }

            JSObject started = new JSObject();
            started.put("transferId", transferId);
            started.put("peerId", peer.optString("id"));
            started.put("files", files);
            started.put("totalSize", total);
            if (folder != null) started.put("folder", folder);
            notifyListeners("sendStarted", started);

            JSONObject offer = new JSONObject();
            offer.put("from", myId);
            offer.put("fromName", myName);
            offer.put("files", files);
            offer.put("totalSize", total);
            if (folder != null) offer.put("folder", folder);
            Resp resp = postJson(peer, "/offer", offer, (int) TimeUnit.SECONDS.toMillis(OFFER_TIMEOUT_SEC + 10));
            JSONObject answer = new JSONObject(resp.body.isEmpty() ? "{}" : resp.body);
            if (resp.code != 200 || !answer.optBoolean("accepted")) {
                emitSend(transferId, "declined", 0, total, null);
                JSObject r = new JSObject();
                r.put("accepted", false);
                call.resolve(r);
                return;
            }
            String token = answer.getString("token");

            long sent = 0;
            byte[] buf = new byte[64 * 1024];
            for (int i = 0; i < uris.size(); i++) {
                JSONObject f = files.getJSONObject(i);
                URL url = new URL("http://" + peer.optString("host") + ":" + peer.optInt("port")
                    + "/file?token=" + enc(token) + "&idx=" + i);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(60000);
                conn.setDoOutput(true);
                conn.setRequestMethod("POST");
                long size = f.optLong("size", -1);
                if (size >= 0) conn.setFixedLengthStreamingMode(size); else conn.setChunkedStreamingMode(64 * 1024);
                try (InputStream in = cr.openInputStream(uris.get(i)); OutputStream out = conn.getOutputStream()) {
                    if (in == null) throw new IOException("Can't read " + f.optString("name"));
                    int n;
                    long lastEmit = 0;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        sent += n;
                        long now = System.currentTimeMillis();
                        if (now - lastEmit > 250) { emitSend(transferId, "sending", sent, total, f.optString("name")); lastEmit = now; }
                    }
                }
                int code = conn.getResponseCode();
                conn.disconnect();
                if (code != 200) throw new IOException("The other phone stopped the transfer (" + code + ")");
            }
            emitSend(transferId, "done", sent, total, null);
            JSObject r = new JSObject();
            r.put("accepted", true);
            call.resolve(r);
        } catch (Exception e) {
            Log.w(TAG, "send failed", e);
            emitSend(transferId, "failed", 0, 0, e.getMessage());
            call.reject("Sending failed: " + e.getMessage());
        }
    }

    private void emitSend(String transferId, String state, long sent, long total, String detail) {
        JSObject e = new JSObject();
        e.put("transferId", transferId);
        e.put("state", state);
        e.put("sent", sent);
        e.put("total", total);
        if (detail != null) e.put("detail", detail);
        notifyListeners("sendProgress", e);
    }

    private static class Resp { int code; String body; }

    private Resp postJson(JSObject peer, String path, JSONObject body, int readTimeoutMs) throws IOException {
        URL url = new URL("http://" + peer.optString("host") + ":" + peer.optInt("port") + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(readTimeoutMs);
        conn.setDoOutput(true);
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = conn.getOutputStream()) { out.write(bytes); }
        Resp r = new Resp();
        r.code = conn.getResponseCode();
        InputStream in = r.code < 400 ? conn.getInputStream() : conn.getErrorStream();
        r.body = in == null ? "" : readAll(in, 1 << 20);
        conn.disconnect();
        return r;
    }

    // ------------------------------------------------------------------ receiving

    @PluginMethod
    public void respond(PluginCall call) {
        Offer o = offers.remove(call.getString("offerId", ""));
        if (o == null) { call.reject("That request has expired"); return; }
        boolean yes = Boolean.TRUE.equals(call.getBoolean("accept", false));
        if (yes && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("storage") != com.getcapacitor.PermissionState.GRANTED) {
            // Ask once; the person can accept again afterwards.
            offers.put(o.id, o);
            requestPermissionForAlias("storage", call, "onStoragePermission");
            return;
        }
        decide(o, yes);
        call.resolve();
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void onStoragePermission(PluginCall call) {
        Offer o = offers.remove(call.getString("offerId", ""));
        if (o == null) { call.reject("That request has expired"); return; }
        decide(o, getPermissionState("storage") == com.getcapacitor.PermissionState.GRANTED);
        call.resolve();
    }

    private void decide(Offer o, boolean yes) {
        if (yes) {
            o.token = randomToken(18);
            accepted.put(o.token, o);
        }
        o.decision = yes;
        o.latch.countDown();
    }

    private void startServer() throws IOException {
        try {
            server = new ServerSocket(PREFERRED_PORT);
        } catch (IOException busy) {
            server = new ServerSocket(0);
        }
        port = server.getLocalPort();
        final ServerSocket s = server;
        pool.execute(() -> {
            while (!s.isClosed()) {
                try {
                    Socket client = s.accept();
                    pool.execute(() -> handle(client));
                } catch (IOException e) {
                    if (!s.isClosed()) Log.w(TAG, "accept failed", e);
                }
            }
        });
    }

    /** A deliberately small HTTP/1.1 handler: one request per connection. */
    private void handle(Socket sock) {
        try (Socket c = sock) {
            c.setSoTimeout(120000);
            InputStream in = c.getInputStream();
            OutputStream out = new BufferedOutputStream(c.getOutputStream());
            String requestLine = readLine(in);
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) { reply(out, 400, "{}"); return; }
            String method = parts[0];
            String target = parts[1];
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int i = line.indexOf(':');
                if (i > 0) headers.put(line.substring(0, i).trim().toLowerCase(Locale.ROOT), line.substring(i + 1).trim());
            }
            String path = target;
            Map<String, String> query = new HashMap<>();
            int qi = target.indexOf('?');
            if (qi >= 0) {
                path = target.substring(0, qi);
                for (String kv : target.substring(qi + 1).split("&")) {
                    int e = kv.indexOf('=');
                    if (e > 0) query.put(URLDecoder.decode(kv.substring(0, e), "UTF-8"), URLDecoder.decode(kv.substring(e + 1), "UTF-8"));
                }
            }
            long length = headers.containsKey("content-length") ? Long.parseLong(headers.get("content-length")) : -1;

            if ("GET".equals(method) && "/info".equals(path)) {
                JSONObject r = new JSONObject();
                r.put("app", "driftshare");
                r.put("id", myId);
                r.put("name", myName);
                reply(out, 200, r.toString());
            } else if ("POST".equals(method) && "/message".equals(path)) {
                JSONObject body = new JSONObject(readBody(in, length, 64 * 1024));
                JSObject e = new JSObject();
                e.put("from", body.optString("from"));
                e.put("fromName", body.optString("fromName"));
                e.put("text", body.optString("text"));
                e.put("ts", System.currentTimeMillis());
                notifyListeners("incomingText", e, true);
                reply(out, 200, "{\"ok\":true}");
            } else if ("POST".equals(method) && "/offer".equals(path)) {
                handleOffer(in, out, length);
            } else if ("POST".equals(method) && "/file".equals(path)) {
                handleFile(in, out, length, query);
            } else {
                reply(out, 404, "{\"error\":\"not found\"}");
            }
        } catch (Exception e) {
            Log.w(TAG, "request failed", e);
        }
    }

    private void handleOffer(InputStream in, OutputStream out, long length) throws Exception {
        JSONObject body = new JSONObject(readBody(in, length, 512 * 1024));
        Offer o = new Offer();
        o.id = randomToken(9);
        o.fromId = body.optString("from");
        o.fromName = body.optString("fromName", "A phone");
        o.files = body.optJSONArray("files");
        if (o.files == null) o.files = new JSONArray();
        o.totalSize = body.optLong("totalSize", 0);
        o.folder = body.has("folder") ? safeName(body.optString("folder")) : null;
        offers.put(o.id, o);

        JSObject e = new JSObject();
        e.put("offerId", o.id);
        e.put("from", o.fromId);
        e.put("fromName", o.fromName);
        e.put("files", new JSArray(o.files.toString()));
        e.put("totalSize", o.totalSize);
        if (o.folder != null) e.put("folder", o.folder);
        notifyListeners("incomingOffer", e, true);

        boolean answered = o.latch.await(OFFER_TIMEOUT_SEC, TimeUnit.SECONDS);
        offers.remove(o.id);
        JSONObject r = new JSONObject();
        if (answered && Boolean.TRUE.equals(o.decision)) {
            r.put("accepted", true);
            r.put("token", o.token);
        } else {
            r.put("accepted", false);
            if (!answered) {
                JSObject t = new JSObject();
                t.put("offerId", o.id);
                notifyListeners("offerExpired", t);
            }
        }
        reply(out, 200, r.toString());
    }

    private void handleFile(InputStream in, OutputStream out, long length, Map<String, String> query) throws Exception {
        Offer o = accepted.get(query.get("token") == null ? "" : query.get("token"));
        int idx;
        try { idx = Integer.parseInt(query.get("idx")); } catch (Exception e) { idx = -1; }
        if (o == null || idx < 0 || idx >= o.files.length()) { reply(out, 403, "{\"error\":\"not accepted\"}"); return; }
        JSONObject fileInfo = o.files.getJSONObject(idx);
        String name = safeName(fileInfo.optString("name", "file"));
        // Files from a folder keep their place inside it: Downloads/Driftshare/Holiday/Day 2/...
        String subdir = "";
        String relPath = name;
        if (fileInfo.has("path")) {
            StringBuilder sb = new StringBuilder();
            String[] parts = fileInfo.optString("path").replace('\\', '/').split("/");
            for (int i = 0; i < parts.length - 1 && i < 24; i++) {
                String part = parts[i];
                if (part.isEmpty() || part.equals(".") || part.equals("..")) continue;
                sb.append('/').append(safeName(part));
            }
            subdir = sb.toString();
            relPath = (subdir.isEmpty() ? "" : subdir.substring(1) + "/") + name;
        }

        Uri saved = null;
        File legacy = null;
        OutputStream fileOut;
        ContentResolver cr = getContext().getContentResolver();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, name);
            v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Driftshare" + subdir);
            v.put(MediaStore.Downloads.IS_PENDING, 1);
            saved = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (saved == null) { reply(out, 500, "{\"error\":\"storage\"}"); return; }
            fileOut = cr.openOutputStream(saved);
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Driftshare" + subdir);
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            legacy = uniqueFile(dir, name);
            fileOut = new FileOutputStream(legacy);
        }

        long got = 0;
        boolean ok = false;
        try (OutputStream fo = fileOut) {
            byte[] buf = new byte[64 * 1024];
            long remaining = length;
            long lastEmit = 0;
            while (remaining != 0) {
                int want = remaining < 0 ? buf.length : (int) Math.min(buf.length, remaining);
                int n = in.read(buf, 0, want);
                if (n < 0) break;
                fo.write(buf, 0, n);
                got += n;
                if (remaining > 0) remaining -= n;
                long now = System.currentTimeMillis();
                if (now - lastEmit > 250) {
                    JSObject e = new JSObject();
                    e.put("offerId", o.id);
                    e.put("name", name);
                    e.put("index", idx);
                    e.put("received", got);
                    notifyListeners("receiveProgress", e);
                    lastEmit = now;
                }
            }
            ok = length < 0 || got == length;
        } finally {
            if (!ok) {
                if (saved != null) cr.delete(saved, null, null);
                if (legacy != null) //noinspection ResultOfMethodCallIgnored
                    legacy.delete();
            }
        }
        if (!ok) { reply(out, 400, "{\"error\":\"incomplete\"}"); return; }

        if (saved != null) {
            ContentValues done = new ContentValues();
            done.put(MediaStore.Downloads.IS_PENDING, 0);
            cr.update(saved, done, null, null);
        }
        synchronized (o) {
            o.received++;
            if (o.received >= o.files.length()) accepted.remove(o.token);
        }
        JSObject e = new JSObject();
        e.put("offerId", o.id);
        e.put("from", o.fromId);
        e.put("fromName", o.fromName);
        e.put("name", name);
        e.put("path", relPath);
        e.put("index", idx);
        e.put("count", o.files.length());
        if (o.folder != null) e.put("folder", o.folder);
        e.put("size", got);
        e.put("uri", saved != null ? saved.toString() : Uri.fromFile(legacy).toString());
        e.put("ts", System.currentTimeMillis());
        notifyListeners("received", e, true);
        reply(out, 200, "{\"ok\":true}");
    }

    @PluginMethod
    public void openReceived(PluginCall call) {
        try {
            Uri uri = Uri.parse(call.getString("uri", ""));
            Intent view = new Intent(Intent.ACTION_VIEW);
            String type = getContext().getContentResolver().getType(uri);
            view.setDataAndType(uri, type != null ? type : "*/*");
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(Intent.createChooser(view, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception e) {
            call.reject("Can't open that file: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------ helpers

    private static String randomToken(int bytes) {
        byte[] b = new byte[bytes];
        RANDOM.nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x));
        return sb.toString();
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    private static String safeName(String n) {
        String base = n.replace('\\', '/');
        base = base.substring(base.lastIndexOf('/') + 1);
        base = base.replaceAll("[<>:\"|?*\\x00-\\x1f]", "_").replaceAll("^\\.+", "").trim();
        if (base.isEmpty()) base = "file";
        return base.length() > 180 ? base.substring(0, 180) : base;
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; f.exists(); i++) f = new File(dir, stem + " (" + i + ")" + ext);
        return f;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new IOException("Header too long");
        }
        if (c == -1 && b.size() == 0) return null;
        return b.toString("UTF-8");
    }

    private static String readBody(InputStream in, long length, int limit) throws IOException {
        if (length < 0 || length > limit) throw new IOException("Bad body length");
        byte[] buf = new byte[(int) length];
        int off = 0;
        while (off < length) {
            int n = in.read(buf, off, (int) length - off);
            if (n < 0) throw new IOException("Body cut short");
            off += n;
        }
        return new String(buf, StandardCharsets.UTF_8);
    }

    private static String readAll(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0 && b.size() < limit) b.write(buf, 0, n);
        in.close();
        return b.toString("UTF-8");
    }

    private static void reply(OutputStream out, int code, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        String status = code == 200 ? "OK" : code == 404 ? "Not Found" : code == 403 ? "Forbidden" : "Error";
        String head = "HTTP/1.1 " + code + " " + status + "\r\n"
            + "Content-Type: application/json\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(body);
        out.flush();
    }
}
