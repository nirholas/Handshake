/*
 * Live connect widget for the hood-connect docs pages. Vanilla JS on top of
 * the framework-free core (global `HoodConnect` from hood-connect.iife.js),
 * so this file doubles as a working integration example: discovery,
 * ensureChain with typed states, and the balance bootstrap check.
 */
(function () {
  'use strict'

  var HC = window.HoodConnect

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text) node.textContent = text
    return node
  }

  function shortAddress(address) {
    return address.slice(0, 6) + '...' + address.slice(-4)
  }

  function trim(value, digits) {
    var parts = String(value).split('.')
    if (parts.length === 1) return parts[0]
    var frac = parts[1].slice(0, digits).replace(/0+$/, '')
    return frac ? parts[0] + '.' + frac : parts[0]
  }

  var INSTALL_LINKS = [
    { name: 'MetaMask', url: 'https://metamask.io/download/' },
    { name: 'Rabby', url: 'https://rabby.io/' },
    { name: 'Coinbase Wallet', url: 'https://www.coinbase.com/wallet/downloads' },
  ]

  window.mountConnectWidget = function mountConnectWidget(root, options) {
    options = options || {}
    var network = options.network || 'mainnet'
    var chain = HC.chainForNetwork(network)

    root.classList.add('hcw')
    var row = el('div', 'hcw-row')
    var message = el('p', 'hcw-msg')
    root.appendChild(row)
    root.appendChild(message)

    function setMessage(text, isError) {
      message.textContent = text || ''
      message.className = 'hcw-msg' + (isError ? ' err' : '')
    }

    function primaryButton(label, busy) {
      var button = el('button', 'hcw-primary')
      if (busy) {
        button.disabled = true
        button.setAttribute('aria-busy', 'true')
        button.appendChild(el('span', 'hcw-spinner'))
      }
      button.appendChild(document.createTextNode(label))
      return button
    }

    function renderBusy(label) {
      row.textContent = ''
      row.appendChild(primaryButton(label, true))
    }

    function renderIdle() {
      row.textContent = ''
      var button = primaryButton('Connect wallet')
      button.addEventListener('click', start)
      row.appendChild(button)
    }

    function renderNoWallet() {
      row.textContent = ''
      setMessage('No wallet extension found. Install one and reload this page:')
      var links = el('div', 'hcw-wallets')
      INSTALL_LINKS.forEach(function (link) {
        var a = el('a', 'hcw-secondary', link.name)
        a.href = link.url
        a.target = '_blank'
        a.rel = 'noreferrer noopener'
        a.style.display = 'inline-block'
        links.appendChild(a)
      })
      row.appendChild(links)
    }

    function renderPicker(wallets) {
      row.textContent = ''
      setMessage('Choose a wallet:')
      var list = el('div', 'hcw-wallets')
      wallets.forEach(function (wallet) {
        var button = el('button', 'hcw-secondary')
        if (wallet.info.icon) {
          var icon = document.createElement('img')
          icon.src = wallet.info.icon
          icon.alt = ''
          button.appendChild(icon)
        }
        button.appendChild(document.createTextNode(wallet.info.name))
        button.addEventListener('click', function () {
          connect(wallet)
        })
        list.appendChild(button)
      })
      row.appendChild(list)
    }

    function renderConnected(address, bootstrap) {
      row.textContent = ''
      var pill = el('span', 'hcw-address')
      pill.appendChild(el('span', 'hcw-dot'))
      pill.appendChild(document.createTextNode(shortAddress(address)))
      row.appendChild(pill)

      if (bootstrap) {
        var balances = el('span', 'hcw-balances')
        balances.innerHTML =
          '<strong>' + trim(bootstrap.ethFormatted, 5) + '</strong> ETH · <strong>' +
          trim(bootstrap.usdgFormatted, 2) + '</strong> USDG'
        row.appendChild(balances)
        if (!bootstrap.funded) {
          setMessage('Connected to ' + chain.name + '. This wallet is empty here; see the funding funnel for one-click bridging.')
        } else {
          setMessage('Connected to ' + chain.name + ' (chain ' + chain.id + ').')
        }
      } else {
        setMessage('Connected to ' + chain.name + ' (chain ' + chain.id + '). Reading balances failed; the public RPC may be busy.')
      }
    }

    function connect(wallet) {
      setMessage('')
      HC.ensureChain(wallet.provider, {
        network: network,
        onState: function (state) {
          if (state.status === 'connecting') renderBusy('Confirm in wallet')
          if (state.status === 'adding') renderBusy('Adding ' + chain.name)
          if (state.status === 'switching') renderBusy('Switching network')
        },
      })
        .then(function (result) {
          renderBusy('Reading balances')
          return HC.checkBootstrap(result.address, { network: network })
            .then(function (bootstrap) {
              renderConnected(result.address, bootstrap)
            })
            .catch(function () {
              renderConnected(result.address, undefined)
            })
        })
        .catch(function (error) {
          renderIdle()
          setMessage(error && error.message ? error.message : String(error), true)
        })
    }

    function start() {
      renderBusy('Looking for wallets')
      HC.discoverWallets({ timeoutMs: 400 }).then(function (wallets) {
        if (wallets.length === 0) return renderNoWallet()
        if (wallets.length === 1) return connect(wallets[0])
        renderPicker(wallets)
      })
    }

    renderIdle()
  }
})()
