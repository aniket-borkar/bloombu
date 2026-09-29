export function HomeScreen() {
  return (
    <div data-testid="home-screen">
      <div className="menu-title">BLMBU PROFESSIONAL</div>
      <div className="white">Type a ticker, press a yellow market-sector key, then &lt;GO&gt;.</div>
      <table className="help-table" style={{ marginTop: 8 }}>
        <tbody>
          <tr>
            <td>AAPL US &lt;EQUITY&gt; &lt;GO&gt;</td>
            <td>Apple Inc. (F8 is the EQUITY key)</td>
          </tr>
          <tr>
            <td>SPX &lt;INDEX&gt; &lt;GO&gt;</td>
            <td>S&amp;P 500 (F10)</td>
          </tr>
          <tr>
            <td>EURUSD &lt;CRNCY&gt; &lt;GO&gt;</td>
            <td>Euro spot (F11)</td>
          </tr>
          <tr>
            <td>CL1 &lt;CMDTY&gt; &lt;GO&gt;</td>
            <td>WTI crude generic 1st (F9)</td>
          </tr>
          <tr>
            <td>HELP &lt;GO&gt; or F1</td>
            <td>Keyboard and syntax reference</td>
          </tr>
        </tbody>
      </table>
      <div className="screen-note">Or start typing a company name to search.</div>
    </div>
  );
}
