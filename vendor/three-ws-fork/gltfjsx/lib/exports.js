'use strict'

var THREE$1 = require('three')
var core = require('@gltf-transform/core')
var functions = require('@gltf-transform/functions')
var extensions = require('@gltf-transform/extensions')
var meshoptimizer = require('meshoptimizer')
var draco3d = require('draco3dgltf')
var sharp = require('sharp')

const isVarName = (str) => {
  // eslint-disable-next-line no-misleading-character-class
  const regex = new RegExp(
    // eslint-disable-next-line no-misleading-character-class
    /^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|null|this|true|void|with|await|break|catch|class|const|false|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)(?:[$A-Z_a-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u05D0-\u05EA\u05EF-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1878\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEF\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7B9\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDD00-\uDD23\uDF00-\uDF1C\uDF27\uDF30-\uDF45]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD44\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF1A]|\uD806[\uDC00-\uDC2B\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDE9D\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD89\uDD98\uDEE0-\uDEF2]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDE40-\uDE7F\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D])(?:[\\$0-9A-Z_a-z\xAA\xB5\xB7\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05EF-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u07FD\u0800-\u082D\u0840-\u085B\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D3-\u08E1\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u09FC\u09FE\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1369-\u1371\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1878\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1CD0-\u1CD2\u1CD4-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u200C\u200D\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEF\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7B9\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDD00-\uDD27\uDD30-\uDD39\uDF00-\uDF1C\uDF27\uDF30-\uDF50]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD44-\uDD46\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDC9-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3B-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC4A\uDC50-\uDC59\uDC5E\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF1A\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDC00-\uDC3A\uDCA0-\uDCE9\uDCFF\uDE00-\uDE3E\uDE47\uDE50-\uDE83\uDE86-\uDE99\uDE9D\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC40\uDC50-\uDC59\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD8E\uDD90\uDD91\uDD93-\uDD98\uDDA0-\uDDA9\uDEE0-\uDEF6]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDE40-\uDE7F\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF])*$/
  )
  return regex.test(str)
}

function parse(fileName, gltf, options = {}) {
  const url = (fileName.toLowerCase().startsWith('http') ? '' : '/') + fileName
  const animations = gltf.animations
  const hasAnimations = animations.length > 0

  // Collect all objects
  const objects = []
  gltf.scene.traverse((child) => objects.push(child))

  // Browse for duplicates
  const duplicates = {
    names: {},
    materials: {},
    geometries: {},
  }

  function uniqueName(attempt, index = 0) {
    const newAttempt = index > 0 ? attempt + index : attempt
    if (Object.values(duplicates.geometries).find(({ name }) => name === newAttempt) === undefined) return newAttempt
    else return uniqueName(attempt, index + 1)
  }

  gltf.scene.traverse((child) => {
    if (child.isMesh) {
      if (child.material) {
        if (!duplicates.materials[child.material.name]) {
          duplicates.materials[child.material.name] = 1
        } else {
          duplicates.materials[child.material.name]++
        }
      }
    }
  })

  gltf.scene.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) {
        const key = child.geometry.uuid + child.material?.name ?? ''
        if (!duplicates.geometries[key]) {
          let name = (child.name || 'Part').replace(/[^a-zA-Z]/g, '')
          name = name.charAt(0).toUpperCase() + name.slice(1)
          duplicates.geometries[key] = {
            count: 1,
            name: uniqueName(name),
            node: 'nodes' + sanitizeName(child.name),
          }
        } else {
          duplicates.geometries[key].count++
        }
      }
    }
  })

  // Prune duplicate geometries
  if (!options.instanceall) {
    for (let key of Object.keys(duplicates.geometries)) {
      const duplicate = duplicates.geometries[key]
      if (duplicate.count === 1) delete duplicates.geometries[key]
    }
  }

  const hasInstances = (options.instance || options.instanceall) && Object.keys(duplicates.geometries).length > 0

  function sanitizeName(name) {
    return isVarName(name) ? `.${name}` : `['${name}']`
  }

  const rNbr = (number) => {
    return parseFloat(number.toFixed(Math.round(options.precision || 2)))
  }

  const rDeg = (number) => {
    const abs = Math.abs(Math.round(parseFloat(number) * 100000))
    for (let i = 1; i <= 10; i++) {
      if (abs === Math.round(parseFloat(Math.PI / i) * 100000))
        return `${number < 0 ? '-' : ''}Math.PI${i > 1 ? ' / ' + i : ''}`
    }
    for (let i = 1; i <= 10; i++) {
      if (abs === Math.round(parseFloat(Math.PI * i) * 100000))
        return `${number < 0 ? '-' : ''}Math.PI${i > 1 ? ' * ' + i : ''}`
    }
    return rNbr(number)
  }

  function printTypes(objects, animations) {
    let meshes = objects.filter((o) => o.isMesh && o.__removed === undefined)
    let bones = objects.filter((o) => o.isBone && !(o.parent && o.parent.isBone) && o.__removed === undefined)
    let materials = [...new Set(objects.filter((o) => o.material && o.material.name).map((o) => o.material))]

    let animationTypes = ''
    if (animations.length) {
      animationTypes = `\n
  type ActionName = ${animations.map((clip, i) => `"${clip.name}"`).join(' | ')};
  type GLTFActions = Record<ActionName, THREE.AnimationAction>;\n`
    }

    return `\ntype GLTFResult = GLTF & {
    nodes: {
      ${meshes.map(({ name, type }) => (isVarName(name) ? name : `['${name}']`) + ': THREE.' + type).join(',')}
      ${bones.map(({ name, type }) => (isVarName(name) ? name : `['${name}']`) + ': THREE.' + type).join(',')}
    }
    materials: {
      ${materials.map(({ name, type }) => (isVarName(name) ? name : `['${name}']`) + ': THREE.' + type).join(',')}
    }
  }\n${animationTypes}`
  }

  function getType(obj) {
    let type = obj.type.charAt(0).toLowerCase() + obj.type.slice(1)
    // Turn object3d's into groups, it should be faster according to the threejs docs
    if (type === 'object3D') type = 'group'
    if (type === 'perspectiveCamera') type = 'PerspectiveCamera'
    if (type === 'orthographicCamera') type = 'OrthographicCamera'
    return type
  }

  function handleProps(obj) {
    let { type, node, instanced } = getInfo(obj)

    let result = ''
    let isCamera = type === 'PerspectiveCamera' || type === 'OrthographicCamera'
    // Handle cameras
    if (isCamera) {
      result += `makeDefault={false} `
      if (obj.zoom !== 1) result += `zoom={${rNbr(obj.zoom)}} `
      if (obj.far !== 2000) result += `far={${rNbr(obj.far)}} `
      if (obj.near !== 0.1) result += `near={${rNbr(obj.near)}} `
    }
    if (type === 'PerspectiveCamera') {
      if (obj.fov !== 50) result += `fov={${rNbr(obj.fov)}} `
    }

    if (!instanced) {
      // Shadows
      if (type === 'mesh' && options.shadows) result += `castShadow receiveShadow `

      // Write out geometry first
      if (obj.geometry) {
        result += `geometry={${node}.geometry} `
      }

      // Write out materials
      if (obj.material) {
        if (obj.material.name) result += `material={materials${sanitizeName(obj.material.name)}} `
        else result += `material={${node}.material} `
      }

      if (obj.skeleton) result += `skeleton={${node}.skeleton} `
      if (obj.visible === false) result += `visible={false} `
      if (obj.castShadow === true) result += `castShadow `
      if (obj.receiveShadow === true) result += `receiveShadow `
      if (obj.morphTargetDictionary) result += `morphTargetDictionary={${node}.morphTargetDictionary} `
      if (obj.morphTargetInfluences) result += `morphTargetInfluences={${node}.morphTargetInfluences} `
      if (obj.intensity && rNbr(obj.intensity)) result += `intensity={${rNbr(obj.intensity)}} `
      //if (obj.power && obj.power !== 4 * Math.PI) result += `power={${rNbr(obj.power)}} `
      if (obj.angle && obj.angle !== Math.PI / 3) result += `angle={${rDeg(obj.angle)}} `
      if (obj.penumbra && rNbr(obj.penumbra) !== 0) result += `penumbra={${rNbr(obj.penumbra)}} `
      if (obj.decay && rNbr(obj.decay) !== 1) result += `decay={${rNbr(obj.decay)}} `
      if (obj.distance && rNbr(obj.distance) !== 0) result += `distance={${rNbr(obj.distance)}} `
      if (obj.up && obj.up.isVector3 && !obj.up.equals(new THREE$1.Vector3(0, 1, 0)))
        result += `up={[${rNbr(obj.up.x)}, ${rNbr(obj.up.y)}, ${rNbr(obj.up.z)},]} `
    }

    if (obj.color && obj.color.getHexString() !== 'ffffff') result += `color="#${obj.color.getHexString()}" `
    if (obj.position && obj.position.isVector3 && rNbr(obj.position.length()))
      result += `position={[${rNbr(obj.position.x)}, ${rNbr(obj.position.y)}, ${rNbr(obj.position.z)},]} `
    if (obj.rotation && obj.rotation.isEuler && rNbr(obj.rotation.toVector3().length()))
      result += `rotation={[${rDeg(obj.rotation.x)}, ${rDeg(obj.rotation.y)}, ${rDeg(obj.rotation.z)},]} `
    if (
      obj.scale &&
      obj.scale.isVector3 &&
      !(rNbr(obj.scale.x) === 1 && rNbr(obj.scale.y) === 1 && rNbr(obj.scale.z) === 1)
    ) {
      const rX = rNbr(obj.scale.x)
      const rY = rNbr(obj.scale.y)
      const rZ = rNbr(obj.scale.z)
      if (rX === rY && rX === rZ) {
        result += `scale={${rX}} `
      } else {
        result += `scale={[${rX}, ${rY}, ${rZ},]} `
      }
    }
    if (options.meta && obj.userData && Object.keys(obj.userData).length)
      result += `userData={${JSON.stringify(obj.userData)}} `

    return result
  }

  function getInfo(obj) {
    let type = getType(obj)
    let node = 'nodes' + sanitizeName(obj.name)
    let instanced =
      (options.instance || options.instanceall) &&
      obj.geometry &&
      obj.material &&
      duplicates.geometries[obj.geometry.uuid + obj.material.name] &&
      duplicates.geometries[obj.geometry.uuid + obj.material.name].count > (options.instanceall ? 0 : 1)
    let animated = gltf.animations && gltf.animations.length > 0
    return { type, node, instanced, animated }
  }

  function equalOrNegated(a, b) {
    return (a.x === b.x || a.x === -b.x) && (a.y === b.y || a.y === -b.y) && (a.z === b.z || a.z === -b.z)
  }

  function prune(obj, children, result, oldResult, silent) {
    let { type, animated } = getInfo(obj)
    // Prune ...
    if (!obj.__removed && !options.keepgroups && !animated && (type === 'group' || type === 'scene')) {
      /** Empty or no-property groups
       *    <group>
       *      <mesh geometry={nodes.foo} material={materials.bar} />
       *  Solution:
       *    <mesh geometry={nodes.foo} material={materials.bar} />
       */
      if (result === oldResult || obj.children.length === 0) {
        if (!silent) console.log(`group ${obj.name} removed (empty)`)
        obj.__removed = true
        return children
      }

      // More aggressive removal strategies ...
      const first = obj.children[0]
      const firstProps = handleProps(first)
      const regex = /([a-z-A-Z]*)={([a-zA-Z0-9\.\[\]\-\,\ \/]*)}/g
      const keys1 = [...result.matchAll(regex)].map(([, match]) => match)
      ;[...result.matchAll(regex)].map(([, , match]) => match)
      const keys2 = [...firstProps.matchAll(regex)].map(([, match]) => match)

      /** Double negative rotations
       *    <group rotation={[-Math.PI / 2, 0, 0]}>
       *      <group rotation={[Math.PI / 2, 0, 0]}>
       *        <mesh geometry={nodes.foo} material={materials.bar} />
       *  Solution:
       *    <mesh geometry={nodes.foo} material={materials.bar} />
       */
      if (obj.children.length === 1 && getType(first) === type && equalOrNegated(obj.rotation, first.rotation)) {
        if (keys1.length === 1 && keys2.length === 1 && keys1[0] === 'rotation' && keys2[0] === 'rotation') {
          if (!silent) console.log(`group ${obj.name} removed (aggressive: double negative rotation)`)
          obj.__removed = first.__removed = true
          children = ''
          if (first.children) first.children.forEach((child) => (children += print(child, true)))
          return children
        }
      }

      /** Double negative rotations w/ props
       *    <group rotation={[-Math.PI / 2, 0, 0]}>
       *      <group rotation={[Math.PI / 2, 0, 0]} scale={0.01}>
       *        <mesh geometry={nodes.foo} material={materials.bar} />
       *  Solution:
       *    <group scale={0.01}>
       *      <mesh geometry={nodes.foo} material={materials.bar} />
       */
      if (obj.children.length === 1 && getType(first) === type && equalOrNegated(obj.rotation, first.rotation)) {
        if (keys1.length === 1 && keys2.length > 1 && keys1[0] === 'rotation' && keys2.includes('rotation')) {
          if (!silent) console.log(`group ${obj.name} removed (aggressive: double negative rotation w/ props)`)
          obj.__removed = true
          // Remove rotation from first child
          first.rotation.set(0, 0, 0)
          children = print(first, true)
          return children
        }
      }

      /** Transform overlap
       *    <group position={[10, 0, 0]} scale={2} rotation={[-Math.PI / 2, 0, 0]}>
       *      <mesh geometry={nodes.foo} material={materials.bar} />
       *  Solution:
       *    <mesh geometry={nodes.foo} material={materials.bar} position={[10, 0, 0]} scale={2} rotation={[-Math.PI / 2, 0, 0]} />
       */
      const isChildTransformed = keys2.includes('position') || keys2.includes('rotation') || keys2.includes('scale')
      const hasOtherProps = keys1.some((key) => !['position', 'scale', 'rotation'].includes(key))
      if (obj.children.length === 1 && !first.__removed && !isChildTransformed && !hasOtherProps) {
        if (!silent) console.log(`group ${obj.name} removed (aggressive: ${keys1.join(' ')} overlap)`)
        // Move props over from the to-be-deleted object to the child
        // This ensures that the child will have the correct transform when pruning is being repeated
        keys1.forEach((key) => obj.children[0][key].copy(obj[key]))
        // Insert the props into the result string
        children = print(first, true)
        obj.__removed = true
        return children
      }

      /** Lack of content
       *    <group position={[10, 0, 0]} scale={2} rotation={[-Math.PI / 2, 0, 0]}>
       *      <group position={[10, 0, 0]} scale={2} rotation={[-Math.PI / 2, 0, 0]}>
       *        <group position={[10, 0, 0]} scale={2} rotation={[-Math.PI / 2, 0, 0]} />
       * Solution:
       *   (delete the whole sub graph)
       */
      const empty = []
      obj.traverse((o) => {
        const type = getType(o)
        if (type !== 'group' && type !== 'object3D') empty.push(o)
      })
      if (!empty.length) {
        if (!silent) console.log(`group ${obj.name} removed (aggressive: lack of content)`)
        empty.forEach((child) => (child.__removed = true))
        return ''
      }
    }
  }

  function print(obj, silent = false) {
    let result = ''
    let children = ''
    let { type, node, instanced, animated } = getInfo(obj)

    // Check if the root node is useless
    if (obj.__removed && obj.children.length) {
      obj.children.forEach((child) => (result += print(child)))
      return result
    }

    // Bail out on lights and bones
    if (type === 'bone') {
      return `<primitive object={${node}} />`
    }

    // Collect children
    if (obj.children) obj.children.forEach((child) => (children += print(child)))

    if (instanced) {
      result = `<instances.${duplicates.geometries[obj.geometry.uuid + obj.material.name].name} `
      type = `instances.${duplicates.geometries[obj.geometry.uuid + obj.material.name].name}`
    } else {
      // Form the object in JSX syntax
      result = `<${type} `
    }

    // Include names when output is uncompressed or morphTargetDictionaries are present
    if (obj.name.length && (options.keepnames || obj.morphTargetDictionary || animated)) result += `name="${obj.name}" `

    const oldResult = result
    result += handleProps(obj)

    const pruned = prune(obj, children, result, oldResult, silent)
    // Bail out if the object was pruned
    if (pruned !== undefined) return pruned

    // Close tag
    result += `${children.length ? '>' : '/>'}\n`

    // Add children and return
    if (children.length) result += children + `</${type}>`
    return result
  }

  function printAnimations(animations) {
    return animations.length
      ? `\nconst { actions } = useAnimations${options.types ? '<GLTFActions>' : ''}(animations, group)`
      : ''
  }

  function parseExtras(extras) {
    if (extras) {
      return (
        Object.keys(extras)
          .map((key) => `${key.charAt(0).toUpperCase() + key.slice(1)}: ${extras[key]}`)
          .join('\n') + '\n'
      )
    } else return ''
  }

  function p(obj, line) {
    console.log(
      [...new Array(line * 2)].map(() => ' ').join(''),
      obj.type,
      obj.name,
      'pos:',
      obj.position.toArray().map(rNbr),
      'scale:',
      obj.scale.toArray().map(rNbr),
      'rot:',
      [obj.rotation.x, obj.rotation.y, obj.rotation.z].map(rNbr),
      'mat:',
      obj.material ? `${obj.material.name}-${obj.material.uuid.substring(0, 8)}` : ''
    )
    obj.children.forEach((o) => p(o, line + 1))
  }

  if (options.debug) p(gltf.scene, 0)

  if (!options.keepgroups) {
    // Dry run to prune graph
    print(gltf.scene)
    // Move children of deleted objects to their new parents
    objects.forEach((o) => {
      if (o.__removed) {
        let parent = o.parent
        // Making sure we don't add to a removed parent
        while (parent && parent.__removed) parent = parent.parent
        // If no parent was found it must be the root node
        if (!parent) parent = gltf.scene
        o.children.slice().forEach((child) => parent.add(child))
      }
    })
    // Remove deleted objects
    objects.forEach((o) => {
      if (o.__removed && o.parent) o.parent.remove(o)
    })
  }
  // 2nd pass to eliminate hard to swat left-overs
  const scene = print(gltf.scene)

  return `/*
${options.header ? options.header : 'Auto-generated by: https://github.com/pmndrs/gltfjsx'}
${parseExtras(gltf.parser.json.asset && gltf.parser.json.asset.extras)}*/
        ${options.types ? `\nimport * as THREE from 'three'` : ''}
        import React, { useRef ${hasInstances ? ', useMemo, useContext, createContext' : ''} } from 'react'
        import { useGLTF, ${hasInstances ? 'Merged, ' : ''} ${
    scene.includes('PerspectiveCamera') ? 'PerspectiveCamera,' : ''
  }
        ${scene.includes('OrthographicCamera') ? 'OrthographicCamera,' : ''}
        ${hasAnimations ? 'useAnimations' : ''} } from '@react-three/drei'
        ${options.types ? 'import { GLTF } from "three-stdlib"' : ''}
        ${options.types ? printTypes(objects, animations) : ''}

        ${
          hasInstances
            ? `
        const context = createContext()
        export function Instances({ children, ...props }) {
          const { nodes } = useGLTF('${url}'${options.draco ? `, ${JSON.stringify(options.draco)}` : ''})${
                options.types ? ' as GLTFResult' : ''
              }
          const instances = useMemo(() => ({
            ${Object.values(duplicates.geometries)
              .map((v) => `${v.name}: ${v.node}`)
              .join(', ')}
          }), [nodes])
          return (
            <Merged meshes={instances} {...props}>
              {(instances) => <context.Provider value={instances} children={children} />}
            </Merged>
          )
        }
        `
            : ''
        }

        export function Model(props${options.types ? ": JSX.IntrinsicElements['group']" : ''}) {
          ${hasInstances ? 'const instances = useContext(context);' : ''} ${
    hasAnimations ? `const group = ${options.types ? 'useRef<THREE.Group>()' : 'useRef()'};` : ''
  } ${
    !options.instanceall
      ? `const { nodes, materials${hasAnimations ? ', animations' : ''} } = useGLTF('${url}'${
          options.draco ? `, ${JSON.stringify(options.draco)}` : ''
        })${options.types ? ' as GLTFResult' : ''}`
      : ''
  } ${printAnimations(animations)}
          return (
            <group ${hasAnimations ? `ref={group}` : ''} {...props} dispose={null}>
        ${scene}
            </group>
          )
        }

useGLTF.preload('${url}')`
}

async function transform(file, output, config = {}) {
  await meshoptimizer.MeshoptDecoder.ready
  await meshoptimizer.MeshoptEncoder.ready
  const io = new core.NodeIO().registerExtensions(extensions.ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'meshopt.decoder': meshoptimizer.MeshoptDecoder,
    'meshopt.encoder': meshoptimizer.MeshoptEncoder,
  })

  const document = await io.read(file)
  const resolution = config.resolution ?? 1024

  const functions$1 = [
    // Losslessly resample animation frames.
    functions.resample(),
    // Remove duplicate vertex or texture data, if any.
    functions.dedup(),
    // Remove unused nodes, textures, or other data.
    functions.prune(),
    // Resize and convert textures (using webp and sharp)
    functions.textureCompress({ targetFormat: 'webp', encoder: sharp, resize: [resolution, resolution] }),
    // Add Draco compression.
    functions.draco(),
  ]

  if (config.simplify) {
    functions$1.push(
      // Weld vertices
      functions.weld({ tolerance: config.weld ?? 0.0001 }),
      // Simplify meshes
      functions.simplify({
        simplifier: meshoptimizer.MeshoptSimplifier,
        ratio: config.ratio ?? 0.75,
        error: config.error ?? 0.001,
      })
    )
  }

  await document.transform(...functions$1)

  await io.write(output, document)
}

var commonjsGlobal =
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
    ? window
    : typeof global !== 'undefined'
    ? global
    : typeof self !== 'undefined'
    ? self
    : {}

THREE$1.GLTFLoader = (function () {
  function GLTFLoader(manager) {
    THREE$1.Loader.call(this, manager)

    this.dracoLoader = null
    this.ddsLoader = null
    this.ktx2Loader = null

    this.pluginCallbacks = []

    this.register(function (parser) {
      return new GLTFMaterialsClearcoatExtension(parser)
    })

    this.register(function (parser) {
      return new GLTFTextureBasisUExtension(parser)
    })

    this.register(function (parser) {
      return new GLTFMaterialsTransmissionExtension(parser)
    })

    this.register(function (parser) {
      return new GLTFLightsExtension(parser)
    })
  }

  GLTFLoader.prototype = Object.assign(Object.create(THREE$1.Loader.prototype), {
    constructor: GLTFLoader,

    load: function (url, onLoad, onProgress, onError) {
      var scope = this

      var resourcePath

      if (this.resourcePath !== '') {
        resourcePath = this.resourcePath
      } else if (this.path !== '') {
        resourcePath = this.path
      } else {
        resourcePath = THREE$1.LoaderUtils.extractUrlBase(url)
      }

      // Tells the LoadingManager to track an extra item, which resolves after
      // the model is fully loaded. This means the count of items loaded will
      // be incorrect, but ensures manager.onLoad() does not fire early.
      this.manager.itemStart(url)

      var _onError = function (e) {
        if (onError) {
          onError(e)
        } else {
          console.error(e)
        }

        scope.manager.itemError(url)
        scope.manager.itemEnd(url)
      }

      var loader = new THREE$1.FileLoader(this.manager)

      loader.setPath(this.path)
      loader.setResponseType('arraybuffer')
      loader.setRequestHeader(this.requestHeader)
      loader.setWithCredentials(this.withCredentials)

      loader.load(
        url,
        function (data) {
          try {
            scope.parse(
              data,
              resourcePath,
              function (gltf) {
                onLoad(gltf)

                scope.manager.itemEnd(url)
              },
              _onError
            )
          } catch (e) {
            _onError(e)
          }
        },
        onProgress,
        _onError
      )
    },

    setDRACOLoader: function (dracoLoader) {
      this.dracoLoader = dracoLoader
      return this
    },

    setDDSLoader: function (ddsLoader) {
      this.ddsLoader = ddsLoader
      return this
    },

    setKTX2Loader: function (ktx2Loader) {
      this.ktx2Loader = ktx2Loader
      return this
    },

    register: function (callback) {
      if (this.pluginCallbacks.indexOf(callback) === -1) {
        this.pluginCallbacks.push(callback)
      }

      return this
    },

    unregister: function (callback) {
      if (this.pluginCallbacks.indexOf(callback) !== -1) {
        this.pluginCallbacks.splice(this.pluginCallbacks.indexOf(callback), 1)
      }

      return this
    },

    parse: function (data, path, onLoad, onError) {
      var content
      var extensions = {}
      var plugins = {}

      if (typeof data === 'string') {
        content = data
      } else {
        var magic = THREE$1.LoaderUtils.decodeText(new Uint8Array(data, 0, 4))

        if (magic === BINARY_EXTENSION_HEADER_MAGIC) {
          try {
            extensions[EXTENSIONS.KHR_BINARY_GLTF] = new GLTFBinaryExtension(data)
          } catch (error) {
            if (onError) onError(error)
            return
          }

          content = extensions[EXTENSIONS.KHR_BINARY_GLTF].content
        } else {
          content = THREE$1.LoaderUtils.decodeText(new Uint8Array(data))
        }
      }

      var json = JSON.parse(content)

      if (json.asset === undefined || json.asset.version[0] < 2) {
        if (onError) onError(new Error('THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are supported.'))
        return
      }

      var parser = new GLTFParser(json, {
        path: path || this.resourcePath || '',
        crossOrigin: this.crossOrigin,
        manager: this.manager,
        ktx2Loader: this.ktx2Loader,
      })

      parser.fileLoader.setRequestHeader(this.requestHeader)

      for (var i = 0; i < this.pluginCallbacks.length; i++) {
        var plugin = this.pluginCallbacks[i](parser)
        plugins[plugin.name] = plugin

        // Workaround to avoid determining as unknown extension
        // in addUnknownExtensionsToUserData().
        // Remove this workaround if we move all the existing
        // extension handlers to plugin system
        extensions[plugin.name] = true
      }

      if (json.extensionsUsed) {
        for (var i = 0; i < json.extensionsUsed.length; ++i) {
          var extensionName = json.extensionsUsed[i]
          var extensionsRequired = json.extensionsRequired || []

          switch (extensionName) {
            case EXTENSIONS.KHR_MATERIALS_UNLIT:
              extensions[extensionName] = new GLTFMaterialsUnlitExtension()
              break

            case EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS:
              extensions[extensionName] = new GLTFMaterialsPbrSpecularGlossinessExtension()
              break

            case EXTENSIONS.KHR_DRACO_MESH_COMPRESSION:
              extensions[extensionName] = new GLTFDracoMeshCompressionExtension(json, this.dracoLoader)
              break

            case EXTENSIONS.MSFT_TEXTURE_DDS:
              extensions[extensionName] = new GLTFTextureDDSExtension(this.ddsLoader)
              break

            case EXTENSIONS.KHR_TEXTURE_TRANSFORM:
              extensions[extensionName] = new GLTFTextureTransformExtension()
              break

            case EXTENSIONS.KHR_MESH_QUANTIZATION:
              extensions[extensionName] = new GLTFMeshQuantizationExtension()
              break

            default:
              if (extensionsRequired.indexOf(extensionName) >= 0 && plugins[extensionName] === undefined);
          }
        }
      }

      parser.setExtensions(extensions)
      parser.setPlugins(plugins)
      parser.parse(onLoad, onError)
    },
  })

  /* GLTFREGISTRY */

  function GLTFRegistry() {
    var objects = {}

    return {
      get: function (key) {
        return objects[key]
      },

      add: function (key, object) {
        objects[key] = object
      },

      remove: function (key) {
        delete objects[key]
      },

      removeAll: function () {
        objects = {}
      },
    }
  }

  /*********************************/
  /********** EXTENSIONS ***********/
  /*********************************/

  var EXTENSIONS = {
    KHR_BINARY_GLTF: 'KHR_binary_glTF',
    KHR_DRACO_MESH_COMPRESSION: 'KHR_draco_mesh_compression',
    KHR_LIGHTS_PUNCTUAL: 'KHR_lights_punctual',
    KHR_MATERIALS_CLEARCOAT: 'KHR_materials_clearcoat',
    KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS: 'KHR_materials_pbrSpecularGlossiness',
    KHR_MATERIALS_TRANSMISSION: 'KHR_materials_transmission',
    KHR_MATERIALS_UNLIT: 'KHR_materials_unlit',
    KHR_TEXTURE_BASISU: 'KHR_texture_basisu',
    KHR_TEXTURE_TRANSFORM: 'KHR_texture_transform',
    KHR_MESH_QUANTIZATION: 'KHR_mesh_quantization',
    MSFT_TEXTURE_DDS: 'MSFT_texture_dds',
  }

  /**
   * DDS Texture Extension
   *
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Vendor/MSFT_texture_dds
   *
   */
  function GLTFTextureDDSExtension(ddsLoader) {
    if (!ddsLoader) {
      throw new Error('THREE.GLTFLoader: Attempting to load .dds texture without importing THREE.DDSLoader')
    }

    this.name = EXTENSIONS.MSFT_TEXTURE_DDS
    this.ddsLoader = ddsLoader
  }

  /**
   * Punctual Lights Extension
   *
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_lights_punctual
   */
  function GLTFLightsExtension(parser) {
    this.parser = parser
    this.name = EXTENSIONS.KHR_LIGHTS_PUNCTUAL

    // Object3D instance caches
    this.cache = { refs: {}, uses: {} }
  }

  GLTFLightsExtension.prototype._markDefs = function () {
    var parser = this.parser
    var nodeDefs = this.parser.json.nodes || []

    for (var nodeIndex = 0, nodeLength = nodeDefs.length; nodeIndex < nodeLength; nodeIndex++) {
      var nodeDef = nodeDefs[nodeIndex]

      if (nodeDef.extensions && nodeDef.extensions[this.name] && nodeDef.extensions[this.name].light !== undefined) {
        parser._addNodeRef(this.cache, nodeDef.extensions[this.name].light)
      }
    }
  }

  GLTFLightsExtension.prototype._loadLight = function (lightIndex) {
    var parser = this.parser
    var cacheKey = 'light:' + lightIndex
    var dependency = parser.cache.get(cacheKey)

    if (dependency) return dependency

    var json = parser.json
    var extensions = (json.extensions && json.extensions[this.name]) || {}
    var lightDefs = extensions.lights || []
    var lightDef = lightDefs[lightIndex]
    var lightNode

    var color = new THREE$1.Color(0xffffff)

    if (lightDef.color !== undefined) color.fromArray(lightDef.color)

    var range = lightDef.range !== undefined ? lightDef.range : 0

    switch (lightDef.type) {
      case 'directional':
        lightNode = new THREE$1.DirectionalLight(color)
        lightNode.target.position.set(0, 0, -1)
        lightNode.add(lightNode.target)
        break

      case 'point':
        lightNode = new THREE$1.PointLight(color)
        lightNode.distance = range
        break

      case 'spot':
        lightNode = new THREE$1.SpotLight(color)
        lightNode.distance = range
        // Handle spotlight properties.
        lightDef.spot = lightDef.spot || {}
        lightDef.spot.innerConeAngle = lightDef.spot.innerConeAngle !== undefined ? lightDef.spot.innerConeAngle : 0
        lightDef.spot.outerConeAngle =
          lightDef.spot.outerConeAngle !== undefined ? lightDef.spot.outerConeAngle : Math.PI / 4.0
        lightNode.angle = lightDef.spot.outerConeAngle
        lightNode.penumbra = 1.0 - lightDef.spot.innerConeAngle / lightDef.spot.outerConeAngle
        lightNode.target.position.set(0, 0, -1)
        lightNode.add(lightNode.target)
        break

      default:
        throw new Error('THREE.GLTFLoader: Unexpected light type, "' + lightDef.type + '".')
    }

    // Some lights (e.g. spot) default to a position other than the origin. Reset the position
    // here, because node-level parsing will only override position if explicitly specified.
    lightNode.position.set(0, 0, 0)

    lightNode.decay = 2

    if (lightDef.intensity !== undefined) lightNode.intensity = lightDef.intensity

    lightNode.name = parser.createUniqueName(lightDef.name || 'light_' + lightIndex)

    dependency = Promise.resolve(lightNode)

    parser.cache.add(cacheKey, dependency)

    return dependency
  }

  GLTFLightsExtension.prototype.createNodeAttachment = function (nodeIndex) {
    var self = this
    var parser = this.parser
    var json = parser.json
    var nodeDef = json.nodes[nodeIndex]
    var lightDef = (nodeDef.extensions && nodeDef.extensions[this.name]) || {}
    var lightIndex = lightDef.light

    if (lightIndex === undefined) return null

    return this._loadLight(lightIndex).then(function (light) {
      return parser._getNodeRef(self.cache, lightIndex, light)
    })
  }

  /**
   * Unlit Materials Extension
   *
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_unlit
   */
  function GLTFMaterialsUnlitExtension() {
    this.name = EXTENSIONS.KHR_MATERIALS_UNLIT
  }

  GLTFMaterialsUnlitExtension.prototype.getMaterialType = function () {
    return THREE$1.MeshBasicMaterial
  }

  GLTFMaterialsUnlitExtension.prototype.extendParams = function (materialParams, materialDef, parser) {
    var pending = []

    materialParams.color = new THREE$1.Color(1.0, 1.0, 1.0)
    materialParams.opacity = 1.0

    var metallicRoughness = materialDef.pbrMetallicRoughness

    if (metallicRoughness) {
      if (Array.isArray(metallicRoughness.baseColorFactor)) {
        var array = metallicRoughness.baseColorFactor

        materialParams.color.fromArray(array)
        materialParams.opacity = array[3]
      }
    }

    return Promise.all(pending)
  }

  /**
   * Clearcoat Materials Extension
   *
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_clearcoat
   */
  function GLTFMaterialsClearcoatExtension(parser) {
    this.parser = parser
    this.name = EXTENSIONS.KHR_MATERIALS_CLEARCOAT
  }

  GLTFMaterialsClearcoatExtension.prototype.getMaterialType = function (materialIndex) {
    var parser = this.parser
    var materialDef = parser.json.materials[materialIndex]

    if (!materialDef.extensions || !materialDef.extensions[this.name]) return null

    return THREE$1.MeshPhysicalMaterial
  }

  GLTFMaterialsClearcoatExtension.prototype.extendMaterialParams = function (materialIndex, materialParams) {
    var parser = this.parser
    var materialDef = parser.json.materials[materialIndex]

    if (!materialDef.extensions || !materialDef.extensions[this.name]) {
      return Promise.resolve()
    }

    var pending = []

    var extension = materialDef.extensions[this.name]

    if (extension.clearcoatFactor !== undefined) {
      materialParams.clearcoat = extension.clearcoatFactor
    }

    if (extension.clearcoatRoughnessFactor !== undefined) {
      materialParams.clearcoatRoughness = extension.clearcoatRoughnessFactor
    }

    if (extension.clearcoatNormalTexture !== undefined) {
      if (extension.clearcoatNormalTexture.scale !== undefined) {
        var scale = extension.clearcoatNormalTexture.scale
        materialParams.clearcoatNormalScale = new THREE$1.Vector2(scale, scale)
      }
    }

    return Promise.all(pending)
  }

  /**
   * Transmission Materials Extension
   *
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_transmission
   * Draft: https://github.com/KhronosGroup/glTF/pull/1698
   */
  function GLTFMaterialsTransmissionExtension(parser) {
    this.parser = parser
    this.name = EXTENSIONS.KHR_MATERIALS_TRANSMISSION
  }

  GLTFMaterialsTransmissionExtension.prototype.getMaterialType = function (materialIndex) {
    var parser = this.parser
    var materialDef = parser.json.materials[materialIndex]

    if (!materialDef.extensions || !materialDef.extensions[this.name]) return null

    return THREE$1.MeshPhysicalMaterial
  }

  GLTFMaterialsTransmissionExtension.prototype.extendMaterialParams = function (materialIndex, materialParams) {
    var parser = this.parser
    var materialDef = parser.json.materials[materialIndex]

    if (!materialDef.extensions || !materialDef.extensions[this.name]) {
      return Promise.resolve()
    }

    var pending = []

    var extension = materialDef.extensions[this.name]

    if (extension.transmissionFactor !== undefined) {
      materialParams.transmission = extension.transmissionFactor
    }

    return Promise.all(pending)
  }

  /**
   * BasisU Texture Extension
   *
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_texture_basisu
   * (draft PR https://github.com/KhronosGroup/glTF/pull/1751)
   */
  function GLTFTextureBasisUExtension(parser) {
    this.parser = parser
    this.name = EXTENSIONS.KHR_TEXTURE_BASISU
  }

  GLTFTextureBasisUExtension.prototype.loadTexture = function (textureIndex) {
    return Promise.resolve(new THREE$1.Texture())
  }

  /* BINARY EXTENSION */
  var BINARY_EXTENSION_HEADER_MAGIC = 'glTF'
  var BINARY_EXTENSION_HEADER_LENGTH = 12
  var BINARY_EXTENSION_CHUNK_TYPES = { JSON: 0x4e4f534a, BIN: 0x004e4942 }

  function GLTFBinaryExtension(data) {
    this.name = EXTENSIONS.KHR_BINARY_GLTF
    this.content = null
    this.body = null

    var headerView = new DataView(data, 0, BINARY_EXTENSION_HEADER_LENGTH)

    this.header = {
      magic: THREE$1.LoaderUtils.decodeText(new Uint8Array(data.slice(0, 4))),
      version: headerView.getUint32(4, true),
      length: headerView.getUint32(8, true),
    }

    if (this.header.magic !== BINARY_EXTENSION_HEADER_MAGIC) {
      throw new Error('THREE.GLTFLoader: Unsupported glTF-Binary header.')
    } else if (this.header.version < 2.0) {
      throw new Error('THREE.GLTFLoader: Legacy binary file detected.')
    }

    var chunkView = new DataView(data, BINARY_EXTENSION_HEADER_LENGTH)
    var chunkIndex = 0

    while (chunkIndex < chunkView.byteLength) {
      var chunkLength = chunkView.getUint32(chunkIndex, true)
      chunkIndex += 4

      var chunkType = chunkView.getUint32(chunkIndex, true)
      chunkIndex += 4

      if (chunkType === BINARY_EXTENSION_CHUNK_TYPES.JSON) {
        var contentArray = new Uint8Array(data, BINARY_EXTENSION_HEADER_LENGTH + chunkIndex, chunkLength)
        this.content = THREE$1.LoaderUtils.decodeText(contentArray)
      } else if (chunkType === BINARY_EXTENSION_CHUNK_TYPES.BIN) {
        var byteOffset = BINARY_EXTENSION_HEADER_LENGTH + chunkIndex
        this.body = data.slice(byteOffset, byteOffset + chunkLength)
      }

      // Clients must ignore chunks with unknown types.

      chunkIndex += chunkLength
    }

    if (this.content === null) {
      throw new Error('THREE.GLTFLoader: JSON content not found.')
    }
  }

  /**
   * DRACO Mesh Compression Extension
   *
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_draco_mesh_compression
   */
  function GLTFDracoMeshCompressionExtension(json, dracoLoader) {
    if (!dracoLoader) {
      throw new Error('THREE.GLTFLoader: No DRACOLoader instance provided.')
    }

    this.name = EXTENSIONS.KHR_DRACO_MESH_COMPRESSION
    this.json = json
    this.dracoLoader = dracoLoader
  }

  GLTFDracoMeshCompressionExtension.prototype.decodePrimitive = function (primitive, parser) {
    var json = this.json
    var dracoLoader = this.dracoLoader
    var bufferViewIndex = primitive.extensions[this.name].bufferView
    var gltfAttributeMap = primitive.extensions[this.name].attributes
    var threeAttributeMap = {}
    var attributeNormalizedMap = {}
    var attributeTypeMap = {}

    for (var attributeName in gltfAttributeMap) {
      var threeAttributeName = ATTRIBUTES[attributeName] || attributeName.toLowerCase()

      threeAttributeMap[threeAttributeName] = gltfAttributeMap[attributeName]
    }

    for (attributeName in primitive.attributes) {
      var threeAttributeName = ATTRIBUTES[attributeName] || attributeName.toLowerCase()

      if (gltfAttributeMap[attributeName] !== undefined) {
        var accessorDef = json.accessors[primitive.attributes[attributeName]]
        var componentType = WEBGL_COMPONENT_TYPES[accessorDef.componentType]

        attributeTypeMap[threeAttributeName] = componentType
        attributeNormalizedMap[threeAttributeName] = accessorDef.normalized === true
      }
    }

    return parser.getDependency('bufferView', bufferViewIndex).then(function (bufferView) {
      return new Promise(function (resolve) {
        dracoLoader.decodeDracoFile(
          bufferView,
          function (geometry) {
            for (var attributeName in geometry.attributes) {
              var attribute = geometry.attributes[attributeName]
              var normalized = attributeNormalizedMap[attributeName]

              if (normalized !== undefined) attribute.normalized = normalized
            }

            resolve(geometry)
          },
          threeAttributeMap,
          attributeTypeMap
        )
      })
    })
  }

  /**
   * Texture Transform Extension
   *
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_texture_transform
   */
  function GLTFTextureTransformExtension() {
    this.name = EXTENSIONS.KHR_TEXTURE_TRANSFORM
  }

  GLTFTextureTransformExtension.prototype.extendTexture = function (texture, transform) {
    texture = texture.clone()

    if (transform.offset !== undefined) {
      texture.offset.fromArray(transform.offset)
    }

    if (transform.rotation !== undefined) {
      texture.rotation = transform.rotation
    }

    if (transform.scale !== undefined) {
      texture.repeat.fromArray(transform.scale)
    }

    if (transform.texCoord !== undefined) {
      console.warn('THREE.GLTFLoader: Custom UV sets in "' + this.name + '" extension not yet supported.')
    }

    texture.needsUpdate = true

    return texture
  }

  /**
   * Specular-Glossiness Extension
   *
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_pbrSpecularGlossiness
   */

  /**
   * A sub class of THREE.StandardMaterial with some of the functionality
   * changed via the `onBeforeCompile` callback
   * @pailhead
   */

  function GLTFMeshStandardSGMaterial(params) {
    THREE$1.MeshStandardMaterial.call(this)

    this.isGLTFSpecularGlossinessMaterial = true

    //various chunks that need replacing
    var specularMapParsFragmentChunk = ['#ifdef USE_SPECULARMAP', '	uniform sampler2D specularMap;', '#endif'].join('\n')

    var glossinessMapParsFragmentChunk = [
      '#ifdef USE_GLOSSINESSMAP',
      '	uniform sampler2D glossinessMap;',
      '#endif',
    ].join('\n')

    var specularMapFragmentChunk = [
      'vec3 specularFactor = specular;',
      '#ifdef USE_SPECULARMAP',
      '	vec4 texelSpecular = texture2D( specularMap, vUv );',
      '	texelSpecular = sRGBToLinear( texelSpecular );',
      '	// reads channel RGB, compatible with a glTF Specular-Glossiness (RGBA) texture',
      '	specularFactor *= texelSpecular.rgb;',
      '#endif',
    ].join('\n')

    var glossinessMapFragmentChunk = [
      'float glossinessFactor = glossiness;',
      '#ifdef USE_GLOSSINESSMAP',
      '	vec4 texelGlossiness = texture2D( glossinessMap, vUv );',
      '	// reads channel A, compatible with a glTF Specular-Glossiness (RGBA) texture',
      '	glossinessFactor *= texelGlossiness.a;',
      '#endif',
    ].join('\n')

    var lightPhysicalFragmentChunk = [
      'PhysicalMaterial material;',
      'material.diffuseColor = diffuseColor.rgb * ( 1. - max( specularFactor.r, max( specularFactor.g, specularFactor.b ) ) );',
      'vec3 dxy = max( abs( dFdx( geometryNormal ) ), abs( dFdy( geometryNormal ) ) );',
      'float geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );',
      'material.specularRoughness = max( 1.0 - glossinessFactor, 0.0525 ); // 0.0525 corresponds to the base mip of a 256 cubemap.',
      'material.specularRoughness += geometryRoughness;',
      'material.specularRoughness = min( material.specularRoughness, 1.0 );',
      'material.specularColor = specularFactor;',
    ].join('\n')

    var uniforms = {
      specular: { value: new THREE$1.Color().setHex(0xffffff) },
      glossiness: { value: 1 },
      specularMap: { value: null },
      glossinessMap: { value: null },
    }

    this._extraUniforms = uniforms

    this.onBeforeCompile = function (shader) {
      for (var uniformName in uniforms) {
        shader.uniforms[uniformName] = uniforms[uniformName]
      }

      shader.fragmentShader = shader.fragmentShader
        .replace('uniform float roughness;', 'uniform vec3 specular;')
        .replace('uniform float metalness;', 'uniform float glossiness;')
        .replace('#include <roughnessmap_pars_fragment>', specularMapParsFragmentChunk)
        .replace('#include <metalnessmap_pars_fragment>', glossinessMapParsFragmentChunk)
        .replace('#include <roughnessmap_fragment>', specularMapFragmentChunk)
        .replace('#include <metalnessmap_fragment>', glossinessMapFragmentChunk)
        .replace('#include <lights_physical_fragment>', lightPhysicalFragmentChunk)
    }

    Object.defineProperties(this, {
      specular: {
        get: function () {
          return uniforms.specular.value
        },
        set: function (v) {
          uniforms.specular.value = v
        },
      },

      specularMap: {
        get: function () {
          return uniforms.specularMap.value
        },
        set: function (v) {
          uniforms.specularMap.value = v

          if (v) {
            this.defines.USE_SPECULARMAP = '' // USE_UV is set by the renderer for specular maps
          } else {
            delete this.defines.USE_SPECULARMAP
          }
        },
      },

      glossiness: {
        get: function () {
          return uniforms.glossiness.value
        },
        set: function (v) {
          uniforms.glossiness.value = v
        },
      },

      glossinessMap: {
        get: function () {
          return uniforms.glossinessMap.value
        },
        set: function (v) {
          uniforms.glossinessMap.value = v

          if (v) {
            this.defines.USE_GLOSSINESSMAP = ''
            this.defines.USE_UV = ''
          } else {
            delete this.defines.USE_GLOSSINESSMAP
            delete this.defines.USE_UV
          }
        },
      },
    })

    delete this.metalness
    delete this.roughness
    delete this.metalnessMap
    delete this.roughnessMap

    this.setValues(params)
  }

  GLTFMeshStandardSGMaterial.prototype = Object.create(THREE$1.MeshStandardMaterial.prototype)
  GLTFMeshStandardSGMaterial.prototype.constructor = GLTFMeshStandardSGMaterial

  GLTFMeshStandardSGMaterial.prototype.copy = function (source) {
    THREE$1.MeshStandardMaterial.prototype.copy.call(this, source)
    this.specularMap = source.specularMap
    this.specular.copy(source.specular)
    this.glossinessMap = source.glossinessMap
    this.glossiness = source.glossiness
    delete this.metalness
    delete this.roughness
    delete this.metalnessMap
    delete this.roughnessMap
    return this
  }

  function GLTFMaterialsPbrSpecularGlossinessExtension() {
    return {
      name: EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS,

      specularGlossinessParams: [
        'color',
        'map',
        'lightMap',
        'lightMapIntensity',
        'aoMap',
        'aoMapIntensity',
        'emissive',
        'emissiveIntensity',
        'emissiveMap',
        'bumpMap',
        'bumpScale',
        'normalMap',
        'normalMapType',
        'displacementMap',
        'displacementScale',
        'displacementBias',
        'specularMap',
        'specular',
        'glossinessMap',
        'glossiness',
        'alphaMap',
        'envMap',
        'envMapIntensity',
        'refractionRatio',
      ],

      getMaterialType: function () {
        return GLTFMeshStandardSGMaterial
      },

      extendParams: function (materialParams, materialDef, parser) {
        var pbrSpecularGlossiness = materialDef.extensions[this.name]

        materialParams.color = new THREE$1.Color(1.0, 1.0, 1.0)
        materialParams.opacity = 1.0

        var pending = []

        if (Array.isArray(pbrSpecularGlossiness.diffuseFactor)) {
          var array = pbrSpecularGlossiness.diffuseFactor

          materialParams.color.fromArray(array)
          materialParams.opacity = array[3]
        }

        materialParams.emissive = new THREE$1.Color(0.0, 0.0, 0.0)
        materialParams.glossiness =
          pbrSpecularGlossiness.glossinessFactor !== undefined ? pbrSpecularGlossiness.glossinessFactor : 1.0
        materialParams.specular = new THREE$1.Color(1.0, 1.0, 1.0)

        if (Array.isArray(pbrSpecularGlossiness.specularFactor)) {
          materialParams.specular.fromArray(pbrSpecularGlossiness.specularFactor)
        }

        return Promise.all(pending)
      },

      createMaterial: function (materialParams) {
        var material = new GLTFMeshStandardSGMaterial(materialParams)
        material.fog = true

        material.color = materialParams.color

        material.map = materialParams.map === undefined ? null : materialParams.map

        material.lightMap = null
        material.lightMapIntensity = 1.0

        material.aoMap = materialParams.aoMap === undefined ? null : materialParams.aoMap
        material.aoMapIntensity = 1.0

        material.emissive = materialParams.emissive
        material.emissiveIntensity = 1.0
        material.emissiveMap = materialParams.emissiveMap === undefined ? null : materialParams.emissiveMap

        material.bumpMap = materialParams.bumpMap === undefined ? null : materialParams.bumpMap
        material.bumpScale = 1

        material.normalMap = materialParams.normalMap === undefined ? null : materialParams.normalMap
        material.normalMapType = THREE$1.TangentSpaceNormalMap

        if (materialParams.normalScale) material.normalScale = materialParams.normalScale

        material.displacementMap = null
        material.displacementScale = 1
        material.displacementBias = 0

        material.specularMap = materialParams.specularMap === undefined ? null : materialParams.specularMap
        material.specular = materialParams.specular

        material.glossinessMap = materialParams.glossinessMap === undefined ? null : materialParams.glossinessMap
        material.glossiness = materialParams.glossiness

        material.alphaMap = null

        material.envMap = materialParams.envMap === undefined ? null : materialParams.envMap
        material.envMapIntensity = 1.0

        material.refractionRatio = 0.98

        return material
      },
    }
  }

  /**
   * Mesh Quantization Extension
   *
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_mesh_quantization
   */
  function GLTFMeshQuantizationExtension() {
    this.name = EXTENSIONS.KHR_MESH_QUANTIZATION
  }

  /*********************************/
  /********** INTERPOLATION ********/
  /*********************************/

  // Spline Interpolation
  // Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#appendix-c-spline-interpolation
  function GLTFCubicSplineInterpolant(parameterPositions, sampleValues, sampleSize, resultBuffer) {
    THREE$1.Interpolant.call(this, parameterPositions, sampleValues, sampleSize, resultBuffer)
  }

  GLTFCubicSplineInterpolant.prototype = Object.create(THREE$1.Interpolant.prototype)
  GLTFCubicSplineInterpolant.prototype.constructor = GLTFCubicSplineInterpolant

  GLTFCubicSplineInterpolant.prototype.copySampleValue_ = function (index) {
    // Copies a sample value to the result buffer. See description of glTF
    // CUBICSPLINE values layout in interpolate_() function below.

    var result = this.resultBuffer,
      values = this.sampleValues,
      valueSize = this.valueSize,
      offset = index * valueSize * 3 + valueSize

    for (var i = 0; i !== valueSize; i++) {
      result[i] = values[offset + i]
    }

    return result
  }

  GLTFCubicSplineInterpolant.prototype.beforeStart_ = GLTFCubicSplineInterpolant.prototype.copySampleValue_

  GLTFCubicSplineInterpolant.prototype.afterEnd_ = GLTFCubicSplineInterpolant.prototype.copySampleValue_

  GLTFCubicSplineInterpolant.prototype.interpolate_ = function (i1, t0, t, t1) {
    var result = this.resultBuffer
    var values = this.sampleValues
    var stride = this.valueSize

    var stride2 = stride * 2
    var stride3 = stride * 3

    var td = t1 - t0

    var p = (t - t0) / td
    var pp = p * p
    var ppp = pp * p

    var offset1 = i1 * stride3
    var offset0 = offset1 - stride3

    var s2 = -2 * ppp + 3 * pp
    var s3 = ppp - pp
    var s0 = 1 - s2
    var s1 = s3 - pp + p

    // Layout of keyframe output values for CUBICSPLINE animations:
    //   [ inTangent_1, splineVertex_1, outTangent_1, inTangent_2, splineVertex_2, ... ]
    for (var i = 0; i !== stride; i++) {
      var p0 = values[offset0 + i + stride] // splineVertex_k
      var m0 = values[offset0 + i + stride2] * td // outTangent_k * (t_k+1 - t_k)
      var p1 = values[offset1 + i + stride] // splineVertex_k+1
      var m1 = values[offset1 + i] * td // inTangent_k+1 * (t_k+1 - t_k)

      result[i] = s0 * p0 + s1 * m0 + s2 * p1 + s3 * m1
    }

    return result
  }

  /*********************************/
  /********** INTERNALS ************/
  /*********************************/

  /* CONSTANTS */

  var WEBGL_CONSTANTS = {
    FLOAT: 5126,
    //FLOAT_MAT2: 35674,
    FLOAT_MAT3: 35675,
    FLOAT_MAT4: 35676,
    FLOAT_VEC2: 35664,
    FLOAT_VEC3: 35665,
    FLOAT_VEC4: 35666,
    LINEAR: 9729,
    REPEAT: 10497,
    SAMPLER_2D: 35678,
    POINTS: 0,
    LINES: 1,
    LINE_LOOP: 2,
    LINE_STRIP: 3,
    TRIANGLES: 4,
    TRIANGLE_STRIP: 5,
    TRIANGLE_FAN: 6,
    UNSIGNED_BYTE: 5121,
    UNSIGNED_SHORT: 5123,
  }

  var WEBGL_COMPONENT_TYPES = {
    5120: Int8Array,
    5121: Uint8Array,
    5122: Int16Array,
    5123: Uint16Array,
    5125: Uint32Array,
    5126: Float32Array,
  }

  ;({
    9728: THREE$1.NearestFilter,
    9729: THREE$1.LinearFilter,
    9984: THREE$1.NearestMipmapNearestFilter,
    9985: THREE$1.LinearMipmapNearestFilter,
    9986: THREE$1.NearestMipmapLinearFilter,
    9987: THREE$1.LinearMipmapLinearFilter,
  })

  ;({
    33071: THREE$1.ClampToEdgeWrapping,
    33648: THREE$1.MirroredRepeatWrapping,
    10497: THREE$1.RepeatWrapping,
  })

  var WEBGL_TYPE_SIZES = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
  }

  var ATTRIBUTES = {
    POSITION: 'position',
    NORMAL: 'normal',
    TANGENT: 'tangent',
    TEXCOORD_0: 'uv',
    TEXCOORD_1: 'uv2',
    COLOR_0: 'color',
    WEIGHTS_0: 'skinWeight',
    JOINTS_0: 'skinIndex',
  }

  var PATH_PROPERTIES = {
    scale: 'scale',
    translation: 'position',
    rotation: 'quaternion',
    weights: 'morphTargetInfluences',
  }

  var INTERPOLATION = {
    CUBICSPLINE: undefined, // We use a custom interpolant (GLTFCubicSplineInterpolation) for CUBICSPLINE tracks. Each
    // keyframe track will be initialized with a default interpolation type, then modified.
    LINEAR: THREE$1.InterpolateLinear,
    STEP: THREE$1.InterpolateDiscrete,
  }

  var ALPHA_MODES = {
    OPAQUE: 'OPAQUE',
    MASK: 'MASK',
    BLEND: 'BLEND',
  }

  /* UTILITY FUNCTIONS */

  function resolveURL(url, path) {
    // Invalid URL
    if (typeof url !== 'string' || url === '') return ''

    // Host Relative URL
    if (/^https?:\/\//i.test(path) && /^\//.test(url)) {
      path = path.replace(/(^https?:\/\/[^\/]+).*/i, '$1')
    }

    // Absolute URL http://,https://,//
    if (/^(https?:)?\/\//i.test(url)) return url

    // Data URI
    if (/^data:.*,.*$/i.test(url)) return url

    // Blob URL
    if (/^blob:.*$/i.test(url)) return url

    // Relative URL
    return path + url
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#default-material
   */
  function createDefaultMaterial(cache) {
    if (cache['DefaultMaterial'] === undefined) {
      cache['DefaultMaterial'] = new THREE$1.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x000000,
        metalness: 1,
        roughness: 1,
        transparent: false,
        depthTest: true,
        side: THREE$1.FrontSide,
      })
    }

    return cache['DefaultMaterial']
  }

  function addUnknownExtensionsToUserData(knownExtensions, object, objectDef) {
    // Add unknown glTF extensions to an object's userData.

    for (var name in objectDef.extensions) {
      if (knownExtensions[name] === undefined) {
        object.userData.gltfExtensions = object.userData.gltfExtensions || {}
        object.userData.gltfExtensions[name] = objectDef.extensions[name]
      }
    }
  }

  /**
   * @param {THREE.Object3D|THREE.Material|THREE.BufferGeometry} object
   * @param {GLTF.definition} gltfDef
   */
  function assignExtrasToUserData(object, gltfDef) {
    if (gltfDef.extras !== undefined) {
      if (typeof gltfDef.extras === 'object') {
        Object.assign(object.userData, gltfDef.extras)
      } else {
        console.warn('THREE.GLTFLoader: Ignoring primitive type .extras, ' + gltfDef.extras)
      }
    }
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#morph-targets
   *
   * @param {THREE.BufferGeometry} geometry
   * @param {Array<GLTF.Target>} targets
   * @param {GLTFParser} parser
   * @return {Promise<THREE.BufferGeometry>}
   */
  function addMorphTargets(geometry, targets, parser) {
    var hasMorphPosition = false
    var hasMorphNormal = false

    for (var i = 0, il = targets.length; i < il; i++) {
      var target = targets[i]

      if (target.POSITION !== undefined) hasMorphPosition = true
      if (target.NORMAL !== undefined) hasMorphNormal = true

      if (hasMorphPosition && hasMorphNormal) break
    }

    if (!hasMorphPosition && !hasMorphNormal) return Promise.resolve(geometry)

    var pendingPositionAccessors = []
    var pendingNormalAccessors = []

    for (var i = 0, il = targets.length; i < il; i++) {
      var target = targets[i]

      if (hasMorphPosition) {
        var pendingAccessor =
          target.POSITION !== undefined
            ? parser.getDependency('accessor', target.POSITION)
            : geometry.attributes.position

        pendingPositionAccessors.push(pendingAccessor)
      }

      if (hasMorphNormal) {
        var pendingAccessor =
          target.NORMAL !== undefined ? parser.getDependency('accessor', target.NORMAL) : geometry.attributes.normal

        pendingNormalAccessors.push(pendingAccessor)
      }
    }

    return Promise.all([Promise.all(pendingPositionAccessors), Promise.all(pendingNormalAccessors)]).then(function (
      accessors
    ) {
      var morphPositions = accessors[0]
      var morphNormals = accessors[1]

      if (hasMorphPosition) geometry.morphAttributes.position = morphPositions
      if (hasMorphNormal) geometry.morphAttributes.normal = morphNormals
      geometry.morphTargetsRelative = true

      return geometry
    })
  }

  /**
   * @param {THREE.Mesh} mesh
   * @param {GLTF.Mesh} meshDef
   */
  function updateMorphTargets(mesh, meshDef) {
    mesh.updateMorphTargets()

    if (meshDef.weights !== undefined) {
      for (var i = 0, il = meshDef.weights.length; i < il; i++) {
        mesh.morphTargetInfluences[i] = meshDef.weights[i]
      }
    }

    // .extras has user-defined data, so check that .extras.targetNames is an array.
    if (meshDef.extras && Array.isArray(meshDef.extras.targetNames)) {
      var targetNames = meshDef.extras.targetNames

      if (mesh.morphTargetInfluences.length === targetNames.length) {
        mesh.morphTargetDictionary = {}

        for (var i = 0, il = targetNames.length; i < il; i++) {
          mesh.morphTargetDictionary[targetNames[i]] = i
        }
      } else {
        console.warn('THREE.GLTFLoader: Invalid extras.targetNames length. Ignoring names.')
      }
    }
  }

  function createPrimitiveKey(primitiveDef) {
    var dracoExtension = primitiveDef.extensions && primitiveDef.extensions[EXTENSIONS.KHR_DRACO_MESH_COMPRESSION]
    var geometryKey

    if (dracoExtension) {
      geometryKey =
        'draco:' +
        dracoExtension.bufferView +
        ':' +
        dracoExtension.indices +
        ':' +
        createAttributesKey(dracoExtension.attributes)
    } else {
      geometryKey = primitiveDef.indices + ':' + createAttributesKey(primitiveDef.attributes) + ':' + primitiveDef.mode
    }

    return geometryKey
  }

  function createAttributesKey(attributes) {
    var attributesKey = ''

    var keys = Object.keys(attributes).sort()

    for (var i = 0, il = keys.length; i < il; i++) {
      attributesKey += keys[i] + ':' + attributes[keys[i]] + ';'
    }

    return attributesKey
  }

  /* GLTF PARSER */

  function GLTFParser(json, options) {
    this.json = json || {}
    this.extensions = {}
    this.plugins = {}
    this.options = options || {}

    // loader object cache
    this.cache = new GLTFRegistry()

    // associations between Three.js objects and glTF elements
    this.associations = new Map()

    // BufferGeometry caching
    this.primitiveCache = {}

    // Object3D instance caches
    this.meshCache = { refs: {}, uses: {} }
    this.cameraCache = { refs: {}, uses: {} }
    this.lightCache = { refs: {}, uses: {} }

    // Track node names, to ensure no duplicates
    this.nodeNamesUsed = {}

    // Use an ImageBitmapLoader if imageBitmaps are supported. Moves much of the
    // expensive work of uploading a texture to the GPU off the main thread.
    if (typeof createImageBitmap !== 'undefined' && /Firefox/.test(navigator.userAgent) === false) {
      this.textureLoader = new THREE$1.ImageBitmapLoader(this.options.manager)
    } else {
      this.textureLoader = new THREE$1.TextureLoader(this.options.manager)
    }

    this.textureLoader.setCrossOrigin(this.options.crossOrigin)

    this.fileLoader = new THREE$1.FileLoader(this.options.manager)
    this.fileLoader.setResponseType('arraybuffer')

    if (this.options.crossOrigin === 'use-credentials') {
      this.fileLoader.setWithCredentials(true)
    }
  }

  GLTFParser.prototype.setExtensions = function (extensions) {
    this.extensions = extensions
  }

  GLTFParser.prototype.setPlugins = function (plugins) {
    this.plugins = plugins
  }

  GLTFParser.prototype.parse = function (onLoad, onError) {
    var parser = this
    var json = this.json
    var extensions = this.extensions

    // Clear the loader cache
    this.cache.removeAll()

    // Mark the special nodes/meshes in json for efficient parse
    this._invokeAll(function (ext) {
      return ext._markDefs && ext._markDefs()
    })

    Promise.all([this.getDependencies('scene'), this.getDependencies('animation'), this.getDependencies('camera')])
      .then(function (dependencies) {
        var result = {
          scene: dependencies[0][json.scene || 0],
          scenes: dependencies[0],
          animations: dependencies[1],
          cameras: dependencies[2],
          asset: json.asset,
          parser: parser,
          userData: {},
        }

        addUnknownExtensionsToUserData(extensions, result, json)

        assignExtrasToUserData(result, json)

        onLoad(result)
      })
      .catch(onError)
  }

  /**
   * Marks the special nodes/meshes in json for efficient parse.
   */
  GLTFParser.prototype._markDefs = function () {
    var nodeDefs = this.json.nodes || []
    var skinDefs = this.json.skins || []
    var meshDefs = this.json.meshes || []

    // Nothing in the node definition indicates whether it is a Bone or an
    // Object3D. Use the skins' joint references to mark bones.
    for (var skinIndex = 0, skinLength = skinDefs.length; skinIndex < skinLength; skinIndex++) {
      var joints = skinDefs[skinIndex].joints

      for (var i = 0, il = joints.length; i < il; i++) {
        nodeDefs[joints[i]].isBone = true
      }
    }

    // Iterate over all nodes, marking references to shared resources,
    // as well as skeleton joints.
    for (var nodeIndex = 0, nodeLength = nodeDefs.length; nodeIndex < nodeLength; nodeIndex++) {
      var nodeDef = nodeDefs[nodeIndex]

      if (nodeDef.mesh !== undefined) {
        this._addNodeRef(this.meshCache, nodeDef.mesh)

        // Nothing in the mesh definition indicates whether it is
        // a SkinnedMesh or Mesh. Use the node's mesh reference
        // to mark SkinnedMesh if node has skin.
        if (nodeDef.skin !== undefined) {
          meshDefs[nodeDef.mesh].isSkinnedMesh = true
        }
      }

      if (nodeDef.camera !== undefined) {
        this._addNodeRef(this.cameraCache, nodeDef.camera)
      }
    }
  }

  /**
   * Counts references to shared node / Object3D resources. These resources
   * can be reused, or "instantiated", at multiple nodes in the scene
   * hierarchy. Mesh, Camera, and Light instances are instantiated and must
   * be marked. Non-scenegraph resources (like Materials, Geometries, and
   * Textures) can be reused directly and are not marked here.
   *
   * Example: CesiumMilkTruck sample model reuses "Wheel" meshes.
   */
  GLTFParser.prototype._addNodeRef = function (cache, index) {
    if (index === undefined) return

    if (cache.refs[index] === undefined) {
      cache.refs[index] = cache.uses[index] = 0
    }

    cache.refs[index]++
  }

  /** Returns a reference to a shared resource, cloning it if necessary. */
  GLTFParser.prototype._getNodeRef = function (cache, index, object) {
    if (cache.refs[index] <= 1) return object

    var ref = object.clone()

    ref.name += '_instance_' + cache.uses[index]++

    return ref
  }

  GLTFParser.prototype._invokeOne = function (func) {
    var extensions = Object.values(this.plugins)
    extensions.push(this)

    for (var i = 0; i < extensions.length; i++) {
      var result = func(extensions[i])

      if (result) return result
    }
  }

  GLTFParser.prototype._invokeAll = function (func) {
    var extensions = Object.values(this.plugins)
    extensions.unshift(this)

    var pending = []

    for (var i = 0; i < extensions.length; i++) {
      var result = func(extensions[i])

      if (result) pending.push(result)
    }

    return pending
  }

  /**
   * Requests the specified dependency asynchronously, with caching.
   * @param {string} type
   * @param {number} index
   * @return {Promise<THREE.Object3D|THREE.Material|THREE.Texture|THREE.AnimationClip|ArrayBuffer|Object>}
   */
  GLTFParser.prototype.getDependency = function (type, index) {
    var cacheKey = type + ':' + index
    var dependency = this.cache.get(cacheKey)

    if (!dependency) {
      switch (type) {
        case 'scene':
          dependency = this.loadScene(index)
          break

        case 'node':
          dependency = this.loadNode(index)
          break

        case 'mesh':
          dependency = this._invokeOne(function (ext) {
            return ext.loadMesh && ext.loadMesh(index)
          })
          break

        case 'accessor':
          dependency = this.loadAccessor(index)
          break

        case 'bufferView':
          dependency = Promise.resolve(new Float32Array(0))
          break

        case 'buffer':
          dependency = Promise.resolve(new Float32Array(0))
          break

        case 'material':
          dependency = this._invokeOne(function (ext) {
            return ext.loadMaterial && ext.loadMaterial(index)
          })
          break

        case 'skin':
          dependency = this.loadSkin(index)
          break

        case 'animation':
          dependency = this.loadAnimation(index)
          break

        case 'camera':
          dependency = this.loadCamera(index)
          break

        default:
          throw new Error('Unknown type: ' + type)
      }

      this.cache.add(cacheKey, dependency)
    }

    return dependency
  }

  /**
   * Requests all dependencies of the specified type asynchronously, with caching.
   * @param {string} type
   * @return {Promise<Array<Object>>}
   */
  GLTFParser.prototype.getDependencies = function (type) {
    var dependencies = this.cache.get(type)

    if (!dependencies) {
      var parser = this
      var defs = this.json[type + (type === 'mesh' ? 'es' : 's')] || []

      dependencies = Promise.all(
        defs.map(function (def, index) {
          return parser.getDependency(type, index)
        })
      )

      this.cache.add(type, dependencies)
    }

    return dependencies
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#buffers-and-buffer-views
   * @param {number} bufferIndex
   * @return {Promise<ArrayBuffer>}
   */
  GLTFParser.prototype.loadBuffer = function (bufferIndex) {
    var bufferDef = this.json.buffers[bufferIndex]
    var loader = this.fileLoader

    if (bufferDef.type && bufferDef.type !== 'arraybuffer') {
      throw new Error('THREE.GLTFLoader: ' + bufferDef.type + ' buffer type is not supported.')
    }

    // If present, GLB container is required to be the first buffer.
    if (bufferDef.uri === undefined && bufferIndex === 0) {
      return Promise.resolve(this.extensions[EXTENSIONS.KHR_BINARY_GLTF].body)
    }

    var options = this.options

    return new Promise(function (resolve, reject) {
      loader.load(resolveURL(bufferDef.uri, options.path), resolve, undefined, function () {
        reject(new Error('THREE.GLTFLoader: Failed to load buffer "' + bufferDef.uri + '".'))
      })
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#buffers-and-buffer-views
   * @param {number} bufferViewIndex
   * @return {Promise<ArrayBuffer>}
   */
  GLTFParser.prototype.loadBufferView = function (bufferViewIndex) {
    var bufferViewDef = this.json.bufferViews[bufferViewIndex]

    return this.getDependency('buffer', bufferViewDef.buffer).then(function (buffer) {
      var byteLength = bufferViewDef.byteLength || 0
      var byteOffset = bufferViewDef.byteOffset || 0
      return buffer.slice(byteOffset, byteOffset + byteLength)
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#accessors
   * @param {number} accessorIndex
   * @return {Promise<THREE.BufferAttribute|THREE.InterleavedBufferAttribute>}
   */
  GLTFParser.prototype.loadAccessor = function (accessorIndex) {
    var parser = this
    var json = this.json

    var accessorDef = this.json.accessors[accessorIndex]

    if (accessorDef.bufferView === undefined && accessorDef.sparse === undefined) {
      // Ignore empty accessors, which may be used to declare runtime
      // information about attributes coming from another source (e.g. Draco
      // compression extension).
      return Promise.resolve(null)
    }

    var pendingBufferViews = []

    if (accessorDef.bufferView !== undefined) {
      pendingBufferViews.push(this.getDependency('bufferView', accessorDef.bufferView))
    } else {
      pendingBufferViews.push(null)
    }

    if (accessorDef.sparse !== undefined) {
      pendingBufferViews.push(this.getDependency('bufferView', accessorDef.sparse.indices.bufferView))
      pendingBufferViews.push(this.getDependency('bufferView', accessorDef.sparse.values.bufferView))
    }

    return Promise.all(pendingBufferViews).then(function (bufferViews) {
      var bufferView = bufferViews[0]

      var itemSize = WEBGL_TYPE_SIZES[accessorDef.type]
      var TypedArray = WEBGL_COMPONENT_TYPES[accessorDef.componentType]

      // For VEC3: itemSize is 3, elementBytes is 4, itemBytes is 12.
      var elementBytes = TypedArray.BYTES_PER_ELEMENT
      var itemBytes = elementBytes * itemSize
      var byteOffset = accessorDef.byteOffset || 0
      var byteStride =
        accessorDef.bufferView !== undefined ? json.bufferViews[accessorDef.bufferView].byteStride : undefined
      var normalized = accessorDef.normalized === true
      var array, bufferAttribute

      // The buffer is not interleaved if the stride is the item size in bytes.
      if (byteStride && byteStride !== itemBytes) {
        // Each "slice" of the buffer, as defined by 'count' elements of 'byteStride' bytes, gets its own InterleavedBuffer
        // This makes sure that IBA.count reflects accessor.count properly
        var ibSlice = Math.floor(byteOffset / byteStride)
        var ibCacheKey =
          'InterleavedBuffer:' +
          accessorDef.bufferView +
          ':' +
          accessorDef.componentType +
          ':' +
          ibSlice +
          ':' +
          accessorDef.count
        var ib = parser.cache.get(ibCacheKey)

        if (!ib) {
          array = new TypedArray(bufferView, ibSlice * byteStride, (accessorDef.count * byteStride) / elementBytes)

          // Integer parameters to IB/IBA are in array elements, not bytes.
          ib = new THREE$1.InterleavedBuffer(array, byteStride / elementBytes)

          parser.cache.add(ibCacheKey, ib)
        }

        bufferAttribute = new THREE$1.InterleavedBufferAttribute(
          ib,
          itemSize,
          (byteOffset % byteStride) / elementBytes,
          normalized
        )
      } else {
        if (bufferView === null) {
          array = new TypedArray(accessorDef.count * itemSize)
        } else {
          array = new TypedArray(bufferView, byteOffset, accessorDef.count * itemSize)
        }

        bufferAttribute = new THREE$1.BufferAttribute(array, itemSize, normalized)
      }

      // https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#sparse-accessors
      if (accessorDef.sparse !== undefined) {
        var itemSizeIndices = WEBGL_TYPE_SIZES.SCALAR
        var TypedArrayIndices = WEBGL_COMPONENT_TYPES[accessorDef.sparse.indices.componentType]

        var byteOffsetIndices = accessorDef.sparse.indices.byteOffset || 0
        var byteOffsetValues = accessorDef.sparse.values.byteOffset || 0

        var sparseIndices = new TypedArrayIndices(
          bufferViews[1],
          byteOffsetIndices,
          accessorDef.sparse.count * itemSizeIndices
        )
        var sparseValues = new TypedArray(bufferViews[2], byteOffsetValues, accessorDef.sparse.count * itemSize)

        if (bufferView !== null) {
          // Avoid modifying the original ArrayBuffer, if the bufferView wasn't initialized with zeroes.
          bufferAttribute = new THREE$1.BufferAttribute(
            bufferAttribute.array.slice(),
            bufferAttribute.itemSize,
            bufferAttribute.normalized
          )
        }

        for (var i = 0, il = sparseIndices.length; i < il; i++) {
          var index = sparseIndices[i]

          bufferAttribute.setX(index, sparseValues[i * itemSize])
          if (itemSize >= 2) bufferAttribute.setY(index, sparseValues[i * itemSize + 1])
          if (itemSize >= 3) bufferAttribute.setZ(index, sparseValues[i * itemSize + 2])
          if (itemSize >= 4) bufferAttribute.setW(index, sparseValues[i * itemSize + 3])
          if (itemSize >= 5) throw new Error('THREE.GLTFLoader: Unsupported itemSize in sparse BufferAttribute.')
        }
      }

      return bufferAttribute
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#textures
   * @param {number} textureIndex
   * @return {Promise<THREE.Texture>}
   */
  GLTFParser.prototype.loadTexture = function (textureIndex) {
    return Promise.resolve(new THREE$1.Texture())
  }

  /**
   * Assigns final material to a Mesh, Line, or Points instance. The instance
   * already has a material (generated from the glTF material options alone)
   * but reuse of the same glTF material may require multiple threejs materials
   * to accomodate different primitive types, defines, etc. New materials will
   * be created if necessary, and reused from a cache.
   * @param  {THREE.Object3D} mesh Mesh, Line, or Points instance.
   */
  GLTFParser.prototype.assignFinalMaterial = function (mesh) {
    var geometry = mesh.geometry
    var material = mesh.material

    var useVertexTangents = geometry.attributes.tangent !== undefined
    var useVertexColors = geometry.attributes.color !== undefined
    var useFlatShading = geometry.attributes.normal === undefined
    var useSkinning = mesh.isSkinnedMesh === true
    var useMorphTargets = Object.keys(geometry.morphAttributes).length > 0
    var useMorphNormals = useMorphTargets && geometry.morphAttributes.normal !== undefined

    if (mesh.isPoints) {
      var cacheKey = 'PointsMaterial:' + material.uuid

      var pointsMaterial = this.cache.get(cacheKey)

      if (!pointsMaterial) {
        pointsMaterial = new THREE$1.PointsMaterial()
        THREE$1.Material.prototype.copy.call(pointsMaterial, material)
        pointsMaterial.color.copy(material.color)
        pointsMaterial.map = material.map
        pointsMaterial.sizeAttenuation = false // glTF spec says points should be 1px

        this.cache.add(cacheKey, pointsMaterial)
      }

      material = pointsMaterial
    } else if (mesh.isLine) {
      var cacheKey = 'LineBasicMaterial:' + material.uuid

      var lineMaterial = this.cache.get(cacheKey)

      if (!lineMaterial) {
        lineMaterial = new THREE$1.LineBasicMaterial()
        THREE$1.Material.prototype.copy.call(lineMaterial, material)
        lineMaterial.color.copy(material.color)

        this.cache.add(cacheKey, lineMaterial)
      }

      material = lineMaterial
    }

    // Clone the material if it will be modified
    if (useVertexTangents || useVertexColors || useFlatShading || useSkinning || useMorphTargets) {
      var cacheKey = 'ClonedMaterial:' + material.uuid + ':'

      if (material.isGLTFSpecularGlossinessMaterial) cacheKey += 'specular-glossiness:'
      if (useSkinning) cacheKey += 'skinning:'
      if (useVertexTangents) cacheKey += 'vertex-tangents:'
      if (useVertexColors) cacheKey += 'vertex-colors:'
      if (useFlatShading) cacheKey += 'flat-shading:'
      if (useMorphTargets) cacheKey += 'morph-targets:'
      if (useMorphNormals) cacheKey += 'morph-normals:'

      var cachedMaterial = this.cache.get(cacheKey)

      if (!cachedMaterial) {
        cachedMaterial = material.clone()

        if (useSkinning) cachedMaterial.skinning = true
        if (useVertexTangents) cachedMaterial.vertexTangents = true
        if (useVertexColors) cachedMaterial.vertexColors = true
        if (useFlatShading) cachedMaterial.flatShading = true
        if (useMorphTargets) cachedMaterial.morphTargets = true
        if (useMorphNormals) cachedMaterial.morphNormals = true

        this.cache.add(cacheKey, cachedMaterial)

        this.associations.set(cachedMaterial, this.associations.get(material))
      }

      material = cachedMaterial
    }

    // workarounds for mesh and geometry

    if (material.aoMap && geometry.attributes.uv2 === undefined && geometry.attributes.uv !== undefined) {
      geometry.setAttribute('uv2', geometry.attributes.uv)
    }

    // https://github.com/mrdoob/three.js/issues/11438#issuecomment-507003995
    if (material.normalScale && !useVertexTangents) {
      material.normalScale.y = -material.normalScale.y
    }

    if (material.clearcoatNormalScale && !useVertexTangents) {
      material.clearcoatNormalScale.y = -material.clearcoatNormalScale.y
    }

    mesh.material = material
  }

  GLTFParser.prototype.getMaterialType = function (/* materialIndex */) {
    return THREE$1.MeshStandardMaterial
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#materials
   * @param {number} materialIndex
   * @return {Promise<THREE.Material>}
   */
  GLTFParser.prototype.loadMaterial = function (materialIndex) {
    var parser = this
    var json = this.json
    var extensions = this.extensions
    var materialDef = json.materials[materialIndex]

    var materialType
    var materialParams = {}
    var materialExtensions = materialDef.extensions || {}

    var pending = []

    if (materialExtensions[EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS]) {
      var sgExtension = extensions[EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS]
      materialType = sgExtension.getMaterialType()
      pending.push(sgExtension.extendParams(materialParams, materialDef, parser))
    } else if (materialExtensions[EXTENSIONS.KHR_MATERIALS_UNLIT]) {
      var kmuExtension = extensions[EXTENSIONS.KHR_MATERIALS_UNLIT]
      materialType = kmuExtension.getMaterialType()
      pending.push(kmuExtension.extendParams(materialParams, materialDef, parser))
    } else {
      // Specification:
      // https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#metallic-roughness-material

      var metallicRoughness = materialDef.pbrMetallicRoughness || {}

      materialParams.color = new THREE$1.Color(1.0, 1.0, 1.0)
      materialParams.opacity = 1.0

      if (Array.isArray(metallicRoughness.baseColorFactor)) {
        var array = metallicRoughness.baseColorFactor

        materialParams.color.fromArray(array)
        materialParams.opacity = array[3]
      }

      materialParams.metalness = metallicRoughness.metallicFactor !== undefined ? metallicRoughness.metallicFactor : 1.0
      materialParams.roughness =
        metallicRoughness.roughnessFactor !== undefined ? metallicRoughness.roughnessFactor : 1.0

      materialType = this._invokeOne(function (ext) {
        return ext.getMaterialType && ext.getMaterialType(materialIndex)
      })

      pending.push(
        Promise.all(
          this._invokeAll(function (ext) {
            return ext.extendMaterialParams && ext.extendMaterialParams(materialIndex, materialParams)
          })
        )
      )
    }

    if (materialDef.doubleSided === true) {
      materialParams.side = THREE$1.DoubleSide
    }

    var alphaMode = materialDef.alphaMode || ALPHA_MODES.OPAQUE

    if (alphaMode === ALPHA_MODES.BLEND) {
      materialParams.transparent = true

      // See: https://github.com/mrdoob/three.js/issues/17706
      materialParams.depthWrite = false
    } else {
      materialParams.transparent = false

      if (alphaMode === ALPHA_MODES.MASK) {
        materialParams.alphaTest = materialDef.alphaCutoff !== undefined ? materialDef.alphaCutoff : 0.5
      }
    }

    if (materialDef.normalTexture !== undefined && materialType !== THREE$1.MeshBasicMaterial) {
      materialParams.normalScale = new THREE$1.Vector2(1, 1)

      if (materialDef.normalTexture.scale !== undefined) {
        materialParams.normalScale.set(materialDef.normalTexture.scale, materialDef.normalTexture.scale)
      }
    }

    if (materialDef.occlusionTexture !== undefined && materialType !== THREE$1.MeshBasicMaterial) {
      if (materialDef.occlusionTexture.strength !== undefined) {
        materialParams.aoMapIntensity = materialDef.occlusionTexture.strength
      }
    }

    if (materialDef.emissiveFactor !== undefined && materialType !== THREE$1.MeshBasicMaterial) {
      materialParams.emissive = new THREE$1.Color().fromArray(materialDef.emissiveFactor)
    }

    return Promise.all(pending).then(function () {
      var material

      if (materialType === GLTFMeshStandardSGMaterial) {
        material = extensions[EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS].createMaterial(materialParams)
      } else {
        material = new materialType(materialParams)
      }

      if (materialDef.name) material.name = materialDef.name

      // baseColorTexture, emissiveTexture, and specularGlossinessTexture use sRGB encoding.
      if (material.map) material.map.encoding = THREE$1.sRGBEncoding
      if (material.emissiveMap) material.emissiveMap.encoding = THREE$1.sRGBEncoding

      assignExtrasToUserData(material, materialDef)

      parser.associations.set(material, { type: 'materials', index: materialIndex })

      if (materialDef.extensions) addUnknownExtensionsToUserData(extensions, material, materialDef)

      return material
    })
  }

  /** When Object3D instances are targeted by animation, they need unique names. */
  GLTFParser.prototype.createUniqueName = function (originalName) {
    var sanitizedName = THREE$1.PropertyBinding.sanitizeNodeName(originalName || '')

    var name = sanitizedName

    for (var i = 1; this.nodeNamesUsed[name]; ++i) {
      name = sanitizedName + '_' + i
    }

    this.nodeNamesUsed[name] = true

    return name
  }

  /**
   * @param {THREE.BufferGeometry} geometry
   * @param {GLTF.Primitive} primitiveDef
   * @param {GLTFParser} parser
   */
  function computeBounds(geometry, primitiveDef, parser) {
    var attributes = primitiveDef.attributes

    var box = new THREE$1.Box3()

    if (attributes.POSITION !== undefined) {
      var accessor = parser.json.accessors[attributes.POSITION]

      var min = accessor.min
      var max = accessor.max

      // glTF requires 'min' and 'max', but VRM (which extends glTF) currently ignores that requirement.

      if (min !== undefined && max !== undefined) {
        box.set(new THREE$1.Vector3(min[0], min[1], min[2]), new THREE$1.Vector3(max[0], max[1], max[2]))
      } else {
        console.warn('THREE.GLTFLoader: Missing min/max properties for accessor POSITION.')

        return
      }
    } else {
      return
    }

    var targets = primitiveDef.targets

    if (targets !== undefined) {
      var maxDisplacement = new THREE$1.Vector3()
      var vector = new THREE$1.Vector3()

      for (var i = 0, il = targets.length; i < il; i++) {
        var target = targets[i]

        if (target.POSITION !== undefined) {
          var accessor = parser.json.accessors[target.POSITION]
          var min = accessor.min
          var max = accessor.max

          // glTF requires 'min' and 'max', but VRM (which extends glTF) currently ignores that requirement.

          if (min !== undefined && max !== undefined) {
            // we need to get max of absolute components because target weight is [-1,1]
            vector.setX(Math.max(Math.abs(min[0]), Math.abs(max[0])))
            vector.setY(Math.max(Math.abs(min[1]), Math.abs(max[1])))
            vector.setZ(Math.max(Math.abs(min[2]), Math.abs(max[2])))

            // Note: this assumes that the sum of all weights is at most 1. This isn't quite correct - it's more conservative
            // to assume that each target can have a max weight of 1. However, for some use cases - notably, when morph targets
            // are used to implement key-frame animations and as such only two are active at a time - this results in very large
            // boxes. So for now we make a box that's sometimes a touch too small but is hopefully mostly of reasonable size.
            maxDisplacement.max(vector)
          } else {
            console.warn('THREE.GLTFLoader: Missing min/max properties for accessor POSITION.')
          }
        }
      }

      // As per comment above this box isn't conservative, but has a reasonable size for a very large number of morph targets.
      box.expandByVector(maxDisplacement)
    }

    geometry.boundingBox = box

    var sphere = new THREE$1.Sphere()

    box.getCenter(sphere.center)
    sphere.radius = box.min.distanceTo(box.max) / 2

    geometry.boundingSphere = sphere
  }

  /**
   * @param {THREE.BufferGeometry} geometry
   * @param {GLTF.Primitive} primitiveDef
   * @param {GLTFParser} parser
   * @return {Promise<THREE.BufferGeometry>}
   */
  function addPrimitiveAttributes(geometry, primitiveDef, parser) {
    var attributes = primitiveDef.attributes

    var pending = []

    function assignAttributeAccessor(accessorIndex, attributeName) {
      return parser.getDependency('accessor', accessorIndex).then(function (accessor) {
        geometry.setAttribute(attributeName, accessor)
      })
    }

    for (var gltfAttributeName in attributes) {
      var threeAttributeName = ATTRIBUTES[gltfAttributeName] || gltfAttributeName.toLowerCase()

      // Skip attributes already provided by e.g. Draco extension.
      if (threeAttributeName in geometry.attributes) continue

      pending.push(assignAttributeAccessor(attributes[gltfAttributeName], threeAttributeName))
    }

    if (primitiveDef.indices !== undefined && !geometry.index) {
      var accessor = parser.getDependency('accessor', primitiveDef.indices).then(function (accessor) {
        geometry.setIndex(accessor)
      })

      pending.push(accessor)
    }

    assignExtrasToUserData(geometry, primitiveDef)

    computeBounds(geometry, primitiveDef, parser)

    return Promise.all(pending).then(function () {
      return primitiveDef.targets !== undefined ? addMorphTargets(geometry, primitiveDef.targets, parser) : geometry
    })
  }

  /**
   * @param {THREE.BufferGeometry} geometry
   * @param {Number} drawMode
   * @return {THREE.BufferGeometry}
   */
  function toTrianglesDrawMode(geometry, drawMode) {
    var index = geometry.getIndex()

    // generate index if not present

    if (index === null) {
      var indices = []

      var position = geometry.getAttribute('position')

      if (position !== undefined) {
        for (var i = 0; i < position.count; i++) {
          indices.push(i)
        }

        geometry.setIndex(indices)
        index = geometry.getIndex()
      } else {
        console.error('THREE.GLTFLoader.toTrianglesDrawMode(): Undefined position attribute. Processing not possible.')
        return geometry
      }
    }

    //

    var numberOfTriangles = index.count - 2
    var newIndices = []

    if (drawMode === THREE$1.TriangleFanDrawMode) {
      // gl.TRIANGLE_FAN

      for (var i = 1; i <= numberOfTriangles; i++) {
        newIndices.push(index.getX(0))
        newIndices.push(index.getX(i))
        newIndices.push(index.getX(i + 1))
      }
    } else {
      // gl.TRIANGLE_STRIP

      for (var i = 0; i < numberOfTriangles; i++) {
        if (i % 2 === 0) {
          newIndices.push(index.getX(i))
          newIndices.push(index.getX(i + 1))
          newIndices.push(index.getX(i + 2))
        } else {
          newIndices.push(index.getX(i + 2))
          newIndices.push(index.getX(i + 1))
          newIndices.push(index.getX(i))
        }
      }
    }

    if (newIndices.length / 3 !== numberOfTriangles) {
      console.error('THREE.GLTFLoader.toTrianglesDrawMode(): Unable to generate correct amount of triangles.')
    }

    // build final geometry

    var newGeometry = geometry.clone()
    newGeometry.setIndex(newIndices)

    return newGeometry
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#geometry
   *
   * Creates BufferGeometries from primitives.
   *
   * @param {Array<GLTF.Primitive>} primitives
   * @return {Promise<Array<THREE.BufferGeometry>>}
   */
  GLTFParser.prototype.loadGeometries = function (primitives) {
    var parser = this
    var extensions = this.extensions
    var cache = this.primitiveCache

    function createDracoPrimitive(primitive) {
      return extensions[EXTENSIONS.KHR_DRACO_MESH_COMPRESSION]
        .decodePrimitive(primitive, parser)
        .then(function (geometry) {
          return addPrimitiveAttributes(geometry, primitive, parser)
        })
    }

    var pending = []

    for (var i = 0, il = primitives.length; i < il; i++) {
      var primitive = primitives[i]
      var cacheKey = createPrimitiveKey(primitive)

      // See if we've already created this geometry
      var cached = cache[cacheKey]

      if (cached) {
        // Use the cached geometry if it exists
        pending.push(cached.promise)
      } else {
        var geometryPromise

        if (primitive.extensions && primitive.extensions[EXTENSIONS.KHR_DRACO_MESH_COMPRESSION]) {
          // Use DRACO geometry if available
          geometryPromise = createDracoPrimitive(primitive)
        } else {
          // Otherwise create a new geometry
          geometryPromise = addPrimitiveAttributes(new THREE$1.BufferGeometry(), primitive, parser)
        }

        // Cache this geometry
        cache[cacheKey] = { primitive: primitive, promise: geometryPromise }

        pending.push(geometryPromise)
      }
    }

    return Promise.all(pending)
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#meshes
   * @param {number} meshIndex
   * @return {Promise<THREE.Group|THREE.Mesh|THREE.SkinnedMesh>}
   */
  GLTFParser.prototype.loadMesh = function (meshIndex) {
    var parser = this
    var json = this.json
    var extensions = this.extensions

    var meshDef = json.meshes[meshIndex]
    var primitives = meshDef.primitives

    var pending = []

    for (var i = 0, il = primitives.length; i < il; i++) {
      var material =
        primitives[i].material === undefined
          ? createDefaultMaterial(this.cache)
          : this.getDependency('material', primitives[i].material)

      pending.push(material)
    }

    pending.push(parser.loadGeometries(primitives))

    return Promise.all(pending).then(function (results) {
      var materials = results.slice(0, results.length - 1)
      var geometries = results[results.length - 1]

      var meshes = []

      for (var i = 0, il = geometries.length; i < il; i++) {
        var geometry = geometries[i]
        var primitive = primitives[i]

        // 1. create Mesh

        var mesh

        var material = materials[i]

        if (
          primitive.mode === WEBGL_CONSTANTS.TRIANGLES ||
          primitive.mode === WEBGL_CONSTANTS.TRIANGLE_STRIP ||
          primitive.mode === WEBGL_CONSTANTS.TRIANGLE_FAN ||
          primitive.mode === undefined
        ) {
          // .isSkinnedMesh isn't in glTF spec. See ._markDefs()
          mesh =
            meshDef.isSkinnedMesh === true
              ? new THREE$1.SkinnedMesh(geometry, material)
              : new THREE$1.Mesh(geometry, material)

          if (primitive.mode === WEBGL_CONSTANTS.TRIANGLE_STRIP) {
            mesh.geometry = toTrianglesDrawMode(mesh.geometry, THREE$1.TriangleStripDrawMode)
          } else if (primitive.mode === WEBGL_CONSTANTS.TRIANGLE_FAN) {
            mesh.geometry = toTrianglesDrawMode(mesh.geometry, THREE$1.TriangleFanDrawMode)
          }
        } else if (primitive.mode === WEBGL_CONSTANTS.LINES) {
          mesh = new THREE$1.LineSegments(geometry, material)
        } else if (primitive.mode === WEBGL_CONSTANTS.LINE_STRIP) {
          mesh = new THREE$1.Line(geometry, material)
        } else if (primitive.mode === WEBGL_CONSTANTS.LINE_LOOP) {
          mesh = new THREE$1.LineLoop(geometry, material)
        } else if (primitive.mode === WEBGL_CONSTANTS.POINTS) {
          mesh = new THREE$1.Points(geometry, material)
        } else {
          throw new Error('THREE.GLTFLoader: Primitive mode unsupported: ' + primitive.mode)
        }

        if (Object.keys(mesh.geometry.morphAttributes).length > 0) {
          updateMorphTargets(mesh, meshDef)
        }

        mesh.name = parser.createUniqueName(meshDef.name || 'mesh_' + meshIndex)

        assignExtrasToUserData(mesh, meshDef)
        if (primitive.extensions) addUnknownExtensionsToUserData(extensions, mesh, primitive)

        parser.assignFinalMaterial(mesh)

        meshes.push(mesh)
      }

      if (meshes.length === 1) {
        return meshes[0]
      }

      var group = new THREE$1.Group()

      for (var i = 0, il = meshes.length; i < il; i++) {
        group.add(meshes[i])
      }

      return group
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#cameras
   * @param {number} cameraIndex
   * @return {Promise<THREE.Camera>}
   */
  GLTFParser.prototype.loadCamera = function (cameraIndex) {
    var camera
    var cameraDef = this.json.cameras[cameraIndex]
    var params = cameraDef[cameraDef.type]

    if (!params) {
      console.warn('THREE.GLTFLoader: Missing camera parameters.')
      return
    }

    if (cameraDef.type === 'perspective') {
      camera = new THREE$1.PerspectiveCamera(
        THREE$1.MathUtils.radToDeg(params.yfov),
        params.aspectRatio || 1,
        params.znear || 1,
        params.zfar || 2e6
      )
    } else if (cameraDef.type === 'orthographic') {
      camera = new THREE$1.OrthographicCamera(
        -params.xmag,
        params.xmag,
        params.ymag,
        -params.ymag,
        params.znear,
        params.zfar
      )
    }

    if (cameraDef.name) camera.name = this.createUniqueName(cameraDef.name)

    assignExtrasToUserData(camera, cameraDef)

    return Promise.resolve(camera)
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#skins
   * @param {number} skinIndex
   * @return {Promise<Object>}
   */
  GLTFParser.prototype.loadSkin = function (skinIndex) {
    var skinDef = this.json.skins[skinIndex]

    var skinEntry = { joints: skinDef.joints }

    if (skinDef.inverseBindMatrices === undefined) {
      return Promise.resolve(skinEntry)
    }

    return this.getDependency('accessor', skinDef.inverseBindMatrices).then(function (accessor) {
      skinEntry.inverseBindMatrices = accessor

      return skinEntry
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#animations
   * @param {number} animationIndex
   * @return {Promise<THREE.AnimationClip>}
   */
  GLTFParser.prototype.loadAnimation = function (animationIndex) {
    var json = this.json

    var animationDef = json.animations[animationIndex]

    var pendingNodes = []
    var pendingInputAccessors = []
    var pendingOutputAccessors = []
    var pendingSamplers = []
    var pendingTargets = []

    for (var i = 0, il = animationDef.channels.length; i < il; i++) {
      var channel = animationDef.channels[i]
      var sampler = animationDef.samplers[channel.sampler]
      var target = channel.target
      var name = target.node !== undefined ? target.node : target.id // NOTE: target.id is deprecated.
      var input = animationDef.parameters !== undefined ? animationDef.parameters[sampler.input] : sampler.input
      var output = animationDef.parameters !== undefined ? animationDef.parameters[sampler.output] : sampler.output

      pendingNodes.push(this.getDependency('node', name))
      pendingInputAccessors.push(this.getDependency('accessor', input))
      pendingOutputAccessors.push(this.getDependency('accessor', output))
      pendingSamplers.push(sampler)
      pendingTargets.push(target)
    }

    return Promise.all([
      Promise.all(pendingNodes),
      Promise.all(pendingInputAccessors),
      Promise.all(pendingOutputAccessors),
      Promise.all(pendingSamplers),
      Promise.all(pendingTargets),
    ]).then(function (dependencies) {
      var nodes = dependencies[0]
      var inputAccessors = dependencies[1]
      var outputAccessors = dependencies[2]
      var samplers = dependencies[3]
      var targets = dependencies[4]

      var tracks = []

      for (var i = 0, il = nodes.length; i < il; i++) {
        var node = nodes[i]
        inputAccessors[i]
        var outputAccessor = outputAccessors[i]
        var sampler = samplers[i]
        var target = targets[i]

        if (node === undefined) continue

        node.updateMatrix()
        node.matrixAutoUpdate = true

        switch (PATH_PROPERTIES[target.path]) {
          case PATH_PROPERTIES.weights:
            THREE$1.NumberKeyframeTrack
            break

          case PATH_PROPERTIES.rotation:
            THREE$1.QuaternionKeyframeTrack
            break

          case PATH_PROPERTIES.position:
          case PATH_PROPERTIES.scale:
          default:
            THREE$1.VectorKeyframeTrack
            break
        }

        var targetName = node.name ? node.name : node.uuid

        sampler.interpolation !== undefined ? INTERPOLATION[sampler.interpolation] : THREE$1.InterpolateLinear

        var targetNames = []

        if (PATH_PROPERTIES[target.path] === PATH_PROPERTIES.weights) {
          // Node may be a THREE.Group (glTF mesh with several primitives) or a THREE.Mesh.
          node.traverse(function (object) {
            if (object.isMesh === true && object.morphTargetInfluences) {
              targetNames.push(object.name ? object.name : object.uuid)
            }
          })
        } else {
          targetNames.push(targetName)
        }

        var outputArray = outputAccessor.array

        if (outputAccessor.normalized) {
          var scale

          if (outputArray.constructor === Int8Array) {
            scale = 1 / 127
          } else if (outputArray.constructor === Uint8Array) {
            scale = 1 / 255
          } else if (outputArray.constructor == Int16Array) {
            scale = 1 / 32767
          } else if (outputArray.constructor === Uint16Array) {
            scale = 1 / 65535
          } else {
            throw new Error('THREE.GLTFLoader: Unsupported output accessor component type.')
          }

          var scaled = new Float32Array(outputArray.length)

          for (var j = 0, jl = outputArray.length; j < jl; j++) {
            scaled[j] = outputArray[j] * scale
          }

          outputArray = scaled
        }
      }

      var name = animationDef.name ? animationDef.name : 'animation_' + animationIndex
      var clip = new THREE$1.AnimationClip(name, undefined, tracks)
      clip.targetNames = targetNames
      return clip
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#nodes-and-hierarchy
   * @param {number} nodeIndex
   * @return {Promise<THREE.Object3D>}
   */
  GLTFParser.prototype.loadNode = function (nodeIndex) {
    var json = this.json
    var extensions = this.extensions
    var parser = this

    var nodeDef = json.nodes[nodeIndex]

    // reserve node's name before its dependencies, so the root has the intended name.
    var nodeName = nodeDef.name ? parser.createUniqueName(nodeDef.name) : ''

    return (function () {
      var pending = []

      if (nodeDef.mesh !== undefined) {
        pending.push(
          parser.getDependency('mesh', nodeDef.mesh).then(function (mesh) {
            var node = parser._getNodeRef(parser.meshCache, nodeDef.mesh, mesh)

            // if weights are provided on the node, override weights on the mesh.
            if (nodeDef.weights !== undefined) {
              node.traverse(function (o) {
                if (!o.isMesh) return

                for (var i = 0, il = nodeDef.weights.length; i < il; i++) {
                  o.morphTargetInfluences[i] = nodeDef.weights[i]
                }
              })
            }

            return node
          })
        )
      }

      if (nodeDef.camera !== undefined) {
        pending.push(
          parser.getDependency('camera', nodeDef.camera).then(function (camera) {
            return parser._getNodeRef(parser.cameraCache, nodeDef.camera, camera)
          })
        )
      }

      parser
        ._invokeAll(function (ext) {
          return ext.createNodeAttachment && ext.createNodeAttachment(nodeIndex)
        })
        .forEach(function (promise) {
          pending.push(promise)
        })

      return Promise.all(pending)
    })().then(function (objects) {
      var node

      // .isBone isn't in glTF spec. See ._markDefs
      if (nodeDef.isBone === true) {
        node = new THREE$1.Bone()
      } else if (objects.length > 1) {
        node = new THREE$1.Group()
      } else if (objects.length === 1) {
        node = objects[0]
      } else {
        node = new THREE$1.Object3D()
      }

      if (node !== objects[0]) {
        for (var i = 0, il = objects.length; i < il; i++) {
          node.add(objects[i])
        }
      }

      if (nodeDef.name) {
        node.userData.name = nodeDef.name
        node.name = nodeName
      }

      assignExtrasToUserData(node, nodeDef)

      if (nodeDef.extensions) addUnknownExtensionsToUserData(extensions, node, nodeDef)

      if (nodeDef.matrix !== undefined) {
        var matrix = new THREE$1.Matrix4()
        matrix.fromArray(nodeDef.matrix)
        node.applyMatrix4(matrix)
      } else {
        if (nodeDef.translation !== undefined) {
          node.position.fromArray(nodeDef.translation)
        }

        if (nodeDef.rotation !== undefined) {
          node.quaternion.fromArray(nodeDef.rotation)
        }

        if (nodeDef.scale !== undefined) {
          node.scale.fromArray(nodeDef.scale)
        }
      }

      parser.associations.set(node, { type: 'nodes', index: nodeIndex })

      return node
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#scenes
   * @param {number} sceneIndex
   * @return {Promise<THREE.Group>}
   */
  GLTFParser.prototype.loadScene = (function () {
    // scene node hierachy builder

    function buildNodeHierachy(nodeId, parentObject, json, parser) {
      var nodeDef = json.nodes[nodeId]

      return parser
        .getDependency('node', nodeId)
        .then(function (node) {
          if (nodeDef.skin === undefined) return node

          // build skeleton here as well

          var skinEntry

          return parser
            .getDependency('skin', nodeDef.skin)
            .then(function (skin) {
              skinEntry = skin

              var pendingJoints = []

              for (var i = 0, il = skinEntry.joints.length; i < il; i++) {
                pendingJoints.push(parser.getDependency('node', skinEntry.joints[i]))
              }

              return Promise.all(pendingJoints)
            })
            .then(function (jointNodes) {
              node.traverse(function (mesh) {
                if (!mesh.isMesh) return

                var bones = []
                var boneInverses = []

                for (var j = 0, jl = jointNodes.length; j < jl; j++) {
                  var jointNode = jointNodes[j]

                  if (jointNode) {
                    bones.push(jointNode)

                    var mat = new THREE$1.Matrix4()

                    if (skinEntry.inverseBindMatrices !== undefined) {
                      mat.fromArray(skinEntry.inverseBindMatrices.array, j * 16)
                    }

                    boneInverses.push(mat)
                  } else {
                    console.warn('THREE.GLTFLoader: Joint "%s" could not be found.', skinEntry.joints[j])
                  }
                }

                mesh.bind(new THREE$1.Skeleton(bones, boneInverses), mesh.matrixWorld)
              })

              return node
            })
        })
        .then(function (node) {
          // build node hierachy

          parentObject.add(node)

          var pending = []

          if (nodeDef.children) {
            var children = nodeDef.children

            for (var i = 0, il = children.length; i < il; i++) {
              var child = children[i]
              pending.push(buildNodeHierachy(child, node, json, parser))
            }
          }

          return Promise.all(pending)
        })
    }

    return function loadScene(sceneIndex) {
      var json = this.json
      var extensions = this.extensions
      var sceneDef = this.json.scenes[sceneIndex]
      var parser = this

      // Loader returns Group, not Scene.
      // See: https://github.com/mrdoob/three.js/issues/18342#issuecomment-578981172
      var scene = new THREE$1.Group()
      if (sceneDef.name) scene.name = parser.createUniqueName(sceneDef.name)

      assignExtrasToUserData(scene, sceneDef)

      if (sceneDef.extensions) addUnknownExtensionsToUserData(extensions, scene, sceneDef)

      var nodeIds = sceneDef.nodes || []

      var pending = []

      for (var i = 0, il = nodeIds.length; i < il; i++) {
        pending.push(buildNodeHierachy(nodeIds[i], scene, json, parser))
      }

      return Promise.all(pending).then(function () {
        return scene
      })
    }
  })()

  return GLTFLoader
})()

const THREE = (commonjsGlobal.THREE = THREE$1)

var glftLoader = THREE.GLTFLoader

exports.GLTFStructureLoader = glftLoader
exports.parse = parse
exports.transform = transform
