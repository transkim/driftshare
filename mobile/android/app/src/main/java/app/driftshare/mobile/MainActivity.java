package app.driftshare.mobile;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Parcelable;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DirectPlugin.class);
        // Opened from another app's Share menu? Remember what was shared before the
        // page loads, so the home screen can offer "Send to…" right away.
        if (savedInstanceState == null) takeShare(getIntent());
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();

        // WebView ignores file downloads by default. Hand them to Android's
        // download manager so files from the PC land in Downloads/Driftshare.
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                    && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 1);
                Toast.makeText(this, "Allow storage access, then tap Download again", Toast.LENGTH_LONG).show();
                return;
            }
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setMimeType(mimeType);
            req.addRequestHeader("User-Agent", userAgent);
            req.setTitle(name);
            req.setDescription("From your PC via Driftshare");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Driftshare/" + name);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            dm.enqueue(req);
            Toast.makeText(this, "Saving " + name + " to Downloads/Driftshare", Toast.LENGTH_SHORT).show();
        });

        // Back button: go back inside the app first, then leave.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (takeShare(intent)) {
            // Already running (maybe showing the PC chat): go back to the home screen,
            // which shows the shared items and asks where to send them.
            getBridge().getWebView().loadUrl("http://localhost/?share=1");
        }
    }

    /** Pull files or text out of a SEND / SEND_MULTIPLE intent. Returns true if there was anything. */
    @SuppressWarnings("deprecation")
    private boolean takeShare(Intent intent) {
        if (intent == null || intent.getAction() == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Parcelable p = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (p instanceof Uri) uris.add((Uri) p);
        } else {
            ArrayList<Parcelable> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) for (Parcelable p : list) if (p instanceof Uri) uris.add((Uri) p);
        }
        // Some apps only put the files in ClipData.
        if (uris.isEmpty() && intent.getClipData() != null) {
            for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
                Uri u = intent.getClipData().getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (uris.isEmpty() && (text == null || text.toString().trim().isEmpty())) return false;
        DirectPlugin.setShared(uris, uris.isEmpty() && text != null ? text.toString() : null);
        // Don't handle the same share twice (e.g. after rotating the screen).
        intent.setAction(Intent.ACTION_MAIN);
        return true;
    }
}
