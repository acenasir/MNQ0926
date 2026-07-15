#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
#endregion

// MNQ Web Exporter — feeds the MNQ0926 strategy website.
//
// Install: NinjaTrader 8 -> New -> NinjaScript Editor -> Indicators -> right-click
// -> Add New... -> paste this file's contents (name: MNQWebExporter) -> compile (F5).
// Then apply the "MNQWebExporter" indicator to a 1-MINUTE chart of MNQ 09-26.
//
// It does two things while the chart is open:
//   1. Serves tick-fresh data at http://localhost:8077/data for the website's
//      LIVE mode (open the site in a browser on this same machine).
//   2. POSTs a bar snapshot to the website's /api/bars endpoint every
//      CloudPushSeconds so the site works from any device (~30s freshness).
//
// Nothing here places orders — it only reads market data.

namespace NinjaTrader.NinjaScript.Indicators
{
	public class MNQWebExporter : Indicator
	{
		private HttpListener listener;
		private Thread listenerThread;
		private Timer pushTimer;
		private static readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
		private readonly object sync = new object();
		private double lastPrice;
		private long lastTradeUnix;
		private volatile bool running;

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Description = "Serves MNQ bars/ticks to the MNQ0926 web dashboard (local tick server + 30s cloud push).";
				Name = "MNQWebExporter";
				Calculate = Calculate.OnEachTick;
				IsOverlay = true;
				DisplayInDataBox = false;

				LocalPort = 8077;
				CloudEndpoint = "https://mnq0926-dashboard.vercel.app/api/bars";
				SecretToken = "change-me-mnq0926";
				CloudPushSeconds = 30;
				BarsToSend = 1500;
			}
			else if (State == State.Realtime)
			{
				running = true;
				StartLocalServer();
				pushTimer = new Timer(_ => PushToCloud(), null,
					TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(Math.Max(5, CloudPushSeconds)));
				Print(string.Format("MNQWebExporter: local feed on http://localhost:{0}/data, cloud push every {1}s to {2}",
					LocalPort, CloudPushSeconds, CloudEndpoint));
			}
			else if (State == State.Terminated)
			{
				running = false;
				try { pushTimer?.Dispose(); } catch { }
				try { listener?.Stop(); listener?.Close(); } catch { }
			}
		}

		protected override void OnMarketData(MarketDataEventArgs e)
		{
			if (e.MarketDataType != MarketDataType.Last) return;
			lock (sync)
			{
				lastPrice = e.Price;
				lastTradeUnix = ToUnix(e.Time);
			}
		}

		protected override void OnBarUpdate() { }

		// ---- local tick server -------------------------------------------------

		private void StartLocalServer()
		{
			try
			{
				listener = new HttpListener();
				listener.Prefixes.Add(string.Format("http://localhost:{0}/", LocalPort));
				listener.Prefixes.Add(string.Format("http://127.0.0.1:{0}/", LocalPort));
				listener.Start();
			}
			catch (Exception ex)
			{
				Print("MNQWebExporter: could not start local server (" + ex.Message + "). " +
					"Run NinjaTrader as admin once, or: netsh http add urlacl url=http://localhost:" + LocalPort + "/ user=Everyone");
				return;
			}

			listenerThread = new Thread(() =>
			{
				while (running && listener.IsListening)
				{
					try
					{
						var ctx = listener.GetContext();
						ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
					}
					catch { /* listener stopped */ }
				}
			}) { IsBackground = true, Name = "MNQWebExporter-http" };
			listenerThread.Start();
		}

		private void Handle(HttpListenerContext ctx)
		{
			try
			{
				var res = ctx.Response;
				// CORS + Chrome Private Network Access, so the deployed HTTPS site
				// may read this local endpoint.
				res.Headers["Access-Control-Allow-Origin"] = "*";
				res.Headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
				res.Headers["Access-Control-Allow-Headers"] = "*";
				res.Headers["Access-Control-Allow-Private-Network"] = "true";
				res.Headers["Cache-Control"] = "no-store";

				if (ctx.Request.HttpMethod == "OPTIONS") { res.StatusCode = 204; res.Close(); return; }

				string body = ctx.Request.Url.AbsolutePath == "/data"
					? BuildJson(BarsToSend)
					: "{\"ok\":true,\"see\":\"/data\"}";
				var buf = Encoding.UTF8.GetBytes(body);
				res.ContentType = "application/json";
				res.ContentLength64 = buf.Length;
				res.OutputStream.Write(buf, 0, buf.Length);
				res.Close();
			}
			catch { /* client went away */ }
		}

		// ---- cloud push ----------------------------------------------------------

		private async void PushToCloud()
		{
			if (!running || string.IsNullOrEmpty(CloudEndpoint) || CloudEndpoint.Contains("YOUR-DEPLOYMENT")) return;
			try
			{
				var content = new StringContent(BuildJson(BarsToSend), Encoding.UTF8, "application/json");
				var req = new HttpRequestMessage(HttpMethod.Post, CloudEndpoint) { Content = content };
				req.Headers.Add("Authorization", "Bearer " + SecretToken);
				var resp = await http.SendAsync(req);
				if (!resp.IsSuccessStatusCode)
					Print("MNQWebExporter: cloud push failed " + (int)resp.StatusCode);
			}
			catch (Exception ex)
			{
				Print("MNQWebExporter: cloud push error " + ex.Message);
			}
		}

		// ---- serialization -------------------------------------------------------

		private long ToUnix(DateTime local)
		{
			return new DateTimeOffset(local, TimeZoneInfo.Local.GetUtcOffset(local)).ToUnixTimeSeconds();
		}

		private string BuildJson(int maxBars)
		{
			var sb = new StringBuilder(maxBars * 64);
			var inv = CultureInfo.InvariantCulture;
			sb.Append("{\"symbol\":\"").Append(Instrument != null ? Instrument.FullName : "MNQ 09-26").Append("\",\"bars\":[");

			lock (sync)
			{
				if (Bars != null && Bars.Count > 0)
				{
					int count = Math.Min(maxBars, Bars.Count);
					int start = Bars.Count - count;
					bool first = true;
					for (int i = start; i < Bars.Count; i++)
					{
						// Bars.GetTime is the bar CLOSE time; the site wants OPEN time.
						long t = ToUnix(Bars.GetTime(i)) - (long)BarsPeriod.Value * 60;
						if (!first) sb.Append(',');
						first = false;
						sb.Append("{\"t\":").Append(t)
						  .Append(",\"o\":").Append(Bars.GetOpen(i).ToString(inv))
						  .Append(",\"h\":").Append(Bars.GetHigh(i).ToString(inv))
						  .Append(",\"l\":").Append(Bars.GetLow(i).ToString(inv))
						  .Append(",\"c\":").Append(Bars.GetClose(i).ToString(inv))
						  .Append(",\"v\":").Append(((long)Bars.GetVolume(i)).ToString(inv))
						  .Append('}');
					}
				}
				sb.Append("],\"last\":");
				if (lastTradeUnix > 0)
					sb.Append("{\"p\":").Append(lastPrice.ToString(inv)).Append(",\"t\":").Append(lastTradeUnix).Append('}');
				else
					sb.Append("null");
			}
			sb.Append('}');
			return sb.ToString();
		}

		#region Properties
		[NinjaScriptProperty]
		[Display(Name = "Local port", GroupName = "MNQ Web Exporter", Order = 1)]
		public int LocalPort { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Cloud endpoint URL", GroupName = "MNQ Web Exporter", Order = 2)]
		public string CloudEndpoint { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Secret token", GroupName = "MNQ Web Exporter", Order = 3)]
		public string SecretToken { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Cloud push interval (s)", GroupName = "MNQ Web Exporter", Order = 4)]
		public int CloudPushSeconds { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Bars to send", GroupName = "MNQ Web Exporter", Order = 5)]
		public int BarsToSend { get; set; }
		#endregion
	}
}
